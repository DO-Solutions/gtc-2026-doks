#!/usr/bin/env python3
"""Collect conversations from the load generator API and create a ShareGPT benchmark dataset.

Polls GET /api/conversations for completed conversations, fetches full records,
reconstructs accumulated message history per turn, and outputs:
  - conversations-raw-<timestamp>.json    — full API records
  - conversations-sharegpt-<timestamp>.json — flattened ShareGPT format for vllm bench

ShareGPT flattening: each turn becomes its own entry. For turn N, the "human" field
contains the full accumulated message history (system + all prior user/assistant turns
+ current user message) concatenated, matching what the model actually received.
"""

import argparse
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen, Request

SYSTEM_PROMPT = (
    "You are a knowledgeable assistant. Engage thoughtfully with the user's "
    "questions, providing detailed explanations."
)


def fetch_json(url: str) -> dict | list:
    req = Request(url, headers={"Accept": "application/json"})
    with urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


def poll_conversations(base_url: str, target: int, timeout: int, interval: int) -> list[dict]:
    """Poll the loadgen API until we have `target` completed conversations."""
    start = time.time()
    collected = {}

    while True:
        elapsed = time.time() - start
        if elapsed >= timeout:
            print(f"\nTimeout after {int(elapsed)}s with {len(collected)}/{target} conversations")
            break

        try:
            summaries = fetch_json(f"{base_url}/api/conversations")
        except (URLError, OSError) as e:
            print(f"\rConnection error: {e} — retrying in {interval}s...", end="", flush=True)
            time.sleep(interval)
            continue

        completed = [s for s in summaries if s.get("status") == "completed"]
        new_count = 0

        for summary in completed:
            cid = summary["id"]
            if cid in collected:
                continue
            try:
                record = fetch_json(f"{base_url}/api/conversations/{cid}")
                # Only keep conversations with the expected number of turns
                if len(record.get("turns", [])) >= 3:
                    collected[cid] = record
                    new_count += 1
            except (URLError, OSError) as e:
                print(f"\nWarning: failed to fetch conversation {cid}: {e}")

        total_available = len([s for s in summaries if s.get("status") in ("completed", "active")])
        print(
            f"\rCollected {len(collected)}/{target} "
            f"(available: {len(completed)} completed, {total_available} total) "
            f"[{int(elapsed)}s elapsed]",
            end="",
            flush=True,
        )

        if len(collected) >= target:
            print()
            break

        time.sleep(interval)

    return list(collected.values())


def reconstruct_history_for_turn(turns: list[dict], turn_index: int) -> list[dict]:
    """Reconstruct the full message history that was sent for a given turn.

    Matches chat.ts lines 54-107: system prompt + accumulated user/assistant pairs.
    """
    messages = [{"role": "system", "content": SYSTEM_PROMPT}]

    for i in range(turn_index + 1):
        turn = turns[i]
        messages.append({"role": "user", "content": turn["userMessage"]})
        if i < turn_index:
            messages.append({"role": "assistant", "content": turn["assistantMessage"]})

    return messages


def conversations_to_sharegpt(conversations: list[dict]) -> list[dict]:
    """Convert conversations to ShareGPT format for vllm bench serve.

    Each turn becomes its own ShareGPT entry. The "human" field contains the
    full accumulated message history concatenated into a single string (since
    benchmark_serving.py only uses the first human+gpt pair per entry).
    """
    entries = []

    for conv in conversations:
        turns = conv.get("turns", [])
        for i, turn in enumerate(turns):
            if not turn.get("assistantMessage"):
                continue

            history = reconstruct_history_for_turn(turns, i)

            # Concatenate all messages into the human field so vllm bench
            # tokenizes the full context that the model originally received
            human_parts = []
            for msg in history:
                prefix = {"system": "[System] ", "user": "[User] ", "assistant": "[Assistant] "}.get(
                    msg["role"], ""
                )
                human_parts.append(f"{prefix}{msg['content']}")
            human_text = "\n\n".join(human_parts)

            entries.append(
                {
                    "conversations": [
                        {"from": "human", "value": human_text},
                        {"from": "gpt", "value": turn["assistantMessage"]},
                    ]
                }
            )

    return entries


def main():
    parser = argparse.ArgumentParser(
        description="Collect conversations from load generator and create ShareGPT benchmark dataset"
    )
    parser.add_argument(
        "--url",
        default="http://localhost:3000",
        help="Load generator base URL (default: http://localhost:3000)",
    )
    parser.add_argument(
        "--target",
        type=int,
        default=100,
        help="Number of completed conversations to collect (default: 100)",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=1800,
        help="Max seconds to wait for target conversations (default: 1800)",
    )
    parser.add_argument(
        "--poll-interval",
        type=int,
        default=10,
        help="Seconds between polls (default: 10)",
    )
    parser.add_argument(
        "--output-dir",
        default="dev/vllm/benchmarks/datasets",
        help="Output directory (default: dev/vllm/benchmarks/datasets)",
    )

    args = parser.parse_args()
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    print(f"Collecting {args.target} conversations from {args.url}")
    print(f"Timeout: {args.timeout}s, poll interval: {args.poll_interval}s")
    print(f"Output dir: {output_dir}")
    print()

    conversations = poll_conversations(args.url, args.target, args.timeout, args.poll_interval)

    if not conversations:
        print("ERROR: No conversations collected", file=sys.stderr)
        sys.exit(1)

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")

    # Write raw conversations
    raw_path = output_dir / f"conversations-raw-{timestamp}.json"
    with open(raw_path, "w") as f:
        json.dump(conversations, f, indent=2)
    print(f"Raw conversations: {raw_path} ({len(conversations)} conversations)")

    # Convert to ShareGPT and write
    sharegpt = conversations_to_sharegpt(conversations)
    sharegpt_path = output_dir / f"conversations-sharegpt-{timestamp}.json"
    with open(sharegpt_path, "w") as f:
        json.dump(sharegpt, f, indent=2)
    print(f"ShareGPT dataset:  {sharegpt_path} ({len(sharegpt)} entries)")

    # Print stats
    turn_counts = [len(c.get("turns", [])) for c in conversations]
    print(f"\nStats:")
    print(f"  Conversations: {len(conversations)}")
    print(f"  Total entries:  {len(sharegpt)}")
    print(f"  Turns/conv:     {min(turn_counts)}-{max(turn_counts)} (avg {sum(turn_counts)/len(turn_counts):.1f})")

    # Verify progressive length
    if sharegpt:
        lengths = [len(e["conversations"][0]["value"]) for e in sharegpt]
        print(f"  Human field:    {min(lengths):,}-{max(lengths):,} chars")


if __name__ == "__main__":
    main()
