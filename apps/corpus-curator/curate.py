#!/usr/bin/env python3
"""Corpus curator for GTC demo workloads.

Loads bundled chat passages and reasoning prompts, fetches summarization docs
from Project Gutenberg, and uploads everything to a Spaces bucket under the
corpus/ prefix.

Usage:
    source ~/env/gtc.env
    python3 apps/corpus-curator/curate.py [--force]
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path

import boto3
import requests

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

ENDPOINT_URL = os.environ.get("ENDPOINT_URL", "https://atl1.digitaloceanspaces.com")
BUCKET = os.environ.get("BUCKET", "do-gtc2026-doks-demo")
SENTINEL_KEY = "corpus/.curator-complete"
CORPUS_PREFIX = "corpus/"

SCRIPT_DIR = Path(__file__).resolve().parent

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def estimate_tokens(text: str) -> int:
    """Rough token estimate: ~1.3 tokens per whitespace-delimited word."""
    return int(len(text.split()) * 1.3)


SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "GTCDemoCorpusCurator/1.0 (booth demo; no scraping)"})


def fetch_with_retry(url: str, max_retries: int = 3, timeout: int = 30) -> requests.Response:
    """GET with exponential backoff."""
    for attempt in range(max_retries):
        try:
            resp = SESSION.get(url, timeout=timeout)
            resp.raise_for_status()
            return resp
        except (requests.RequestException, requests.HTTPError) as exc:
            if attempt == max_retries - 1:
                raise
            wait = 2 ** attempt
            print(f"  Retry {attempt + 1}/{max_retries} for {url} ({exc}), waiting {wait}s")
            time.sleep(wait)


def upload_jsonl(s3, bucket: str, key: str, records: list[dict]):
    """Upload a list of dicts as newline-delimited JSON."""
    body = "\n".join(json.dumps(r, ensure_ascii=False) for r in records) + "\n"
    s3.put_object(Bucket=bucket, Key=key, Body=body.encode("utf-8"), ContentType="application/jsonl")
    print(f"  Uploaded s3://{bucket}/{key} ({len(records)} records, {len(body)} bytes)")


# ---------------------------------------------------------------------------
# Chat passages (bundled)
# ---------------------------------------------------------------------------

def load_chat_passages() -> list[dict]:
    """Load bundled chat passages and add token counts."""
    print("Loading chat passages...")
    passages_path = SCRIPT_DIR / "prompts" / "chat_passages.json"
    with open(passages_path) as f:
        raw = json.load(f)

    passages = []
    for p in raw:
        token_count = estimate_tokens(p["text"])
        passages.append({
            "id": p["id"],
            "text": p["text"],
            "topic": p["topic"],
            "token_count": token_count,
        })
        print(f"  {p['topic']}: {token_count} tokens")
    print(f"  Loaded {len(passages)} chat passages")
    return passages


# ---------------------------------------------------------------------------
# Summarization docs (Project Gutenberg)
# ---------------------------------------------------------------------------

# (id, title, length_bucket)
GUTENBERG_BOOKS = [
    # short (3)
    (84, "Frankenstein", "short"),
    (1661, "The Adventures of Sherlock Holmes", "short"),
    (11, "Alice's Adventures in Wonderland", "short"),
    # medium (4)
    (1342, "Pride and Prejudice", "medium"),
    (174, "The Picture of Dorian Gray", "medium"),
    (2701, "Moby Dick", "medium"),
    (1080, "A Modest Proposal", "medium"),
    # long (3)
    (98, "A Tale of Two Cities", "long"),
    (1260, "Jane Eyre", "long"),
    (16328, "Beowulf", "long"),
]

# Token targets per bucket
TOKEN_TARGETS = {"short": 4000, "medium": 10000, "long": 18000}


def strip_gutenberg_boilerplate(text: str) -> str:
    """Remove Project Gutenberg header and footer."""
    # Find start of actual text
    start_markers = [
        "*** START OF THE PROJECT GUTENBERG EBOOK",
        "*** START OF THIS PROJECT GUTENBERG EBOOK",
        "***START OF THE PROJECT GUTENBERG EBOOK",
    ]
    end_markers = [
        "*** END OF THE PROJECT GUTENBERG EBOOK",
        "*** END OF THIS PROJECT GUTENBERG EBOOK",
        "***END OF THE PROJECT GUTENBERG EBOOK",
        "End of the Project Gutenberg EBook",
        "End of Project Gutenberg's",
    ]

    start_idx = 0
    for marker in start_markers:
        idx = text.find(marker)
        if idx != -1:
            # Skip past the marker line
            start_idx = text.index("\n", idx) + 1
            break

    end_idx = len(text)
    for marker in end_markers:
        idx = text.find(marker)
        if idx != -1:
            end_idx = idx
            break

    return text[start_idx:end_idx].strip()


def fetch_summarization_docs() -> dict[str, list[dict]]:
    """Fetch excerpts from Project Gutenberg, bucketed by length."""
    print("Fetching summarization docs from Project Gutenberg...")
    docs_by_bucket: dict[str, list[dict]] = {"short": [], "medium": [], "long": []}

    for i, (book_id, title, bucket) in enumerate(GUTENBERG_BOOKS):
        url = f"https://www.gutenberg.org/cache/epub/{book_id}/pg{book_id}.txt"
        try:
            resp = fetch_with_retry(url)
            text = strip_gutenberg_boilerplate(resp.text)

            # Trim to target token count (rough: 1 token ≈ 0.77 words)
            target = TOKEN_TARGETS[bucket]
            words = text.split()
            target_words = int(target / 1.3)
            if len(words) > target_words:
                text = " ".join(words[:target_words])
                # End at last sentence boundary
                last_period = text.rfind(".")
                if last_period > len(text) * 0.8:
                    text = text[:last_period + 1]

            token_count = estimate_tokens(text)
            docs_by_bucket[bucket].append({
                "id": f"summ-{i+1:02d}",
                "text": text,
                "source": f"gutenberg:{book_id}",
                "title": title,
                "token_count": token_count,
            })
            print(f"  [{i+1}/{len(GUTENBERG_BOOKS)}] {title} ({bucket}): {token_count} tokens")
        except Exception as exc:
            print(f"  ERROR fetching {title} (id={book_id}): {exc}")

    return docs_by_bucket


# ---------------------------------------------------------------------------
# Reasoning prompts
# ---------------------------------------------------------------------------

def load_reasoning_prompts() -> list[dict]:
    """Load bundled reasoning prompts and add token counts."""
    print("Loading reasoning prompts...")
    prompts_path = SCRIPT_DIR / "prompts" / "reasoning.json"
    with open(prompts_path) as f:
        prompts = json.load(f)

    records = []
    for p in prompts:
        records.append({
            "id": p["id"],
            "prompt": p["prompt"],
            "category": p["category"],
            "expected_output_length": p["expected_output_length"],
            "prompt_token_count": estimate_tokens(p["prompt"]),
        })
    print(f"  Loaded {len(records)} reasoning prompts")
    return records


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Curate and upload demo corpus to Spaces")
    parser.add_argument("--force", action="store_true", help="Re-upload even if sentinel exists")
    args = parser.parse_args()

    # Validate credentials
    for var in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"):
        if not os.environ.get(var):
            print(f"ERROR: {var} not set. Run: source ~/env/gtc.env")
            sys.exit(1)

    s3 = boto3.client(
        "s3",
        endpoint_url=ENDPOINT_URL,
        aws_access_key_id=os.environ["AWS_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["AWS_SECRET_ACCESS_KEY"],
        region_name="us-east-1",  # required by boto3 but ignored by Spaces
    )

    # Check sentinel
    if not args.force:
        try:
            s3.head_object(Bucket=BUCKET, Key=SENTINEL_KEY)
            print(f"Sentinel found at s3://{BUCKET}/{SENTINEL_KEY} — corpus already uploaded.")
            print("Use --force to re-upload.")
            sys.exit(0)
        except s3.exceptions.ClientError:
            pass  # sentinel doesn't exist, proceed

    # --- Fetch / Load ---
    chat_passages = load_chat_passages()
    summ_docs = fetch_summarization_docs()
    reasoning_prompts = load_reasoning_prompts()

    # --- Upload ---
    print("\nUploading to Spaces...")
    upload_jsonl(s3, BUCKET, "corpus/chat/passages.jsonl", chat_passages)

    for bucket_name in ("short", "medium", "long"):
        docs = summ_docs.get(bucket_name, [])
        if docs:
            upload_jsonl(s3, BUCKET, f"corpus/summarization/{bucket_name}/docs.jsonl", docs)

    upload_jsonl(s3, BUCKET, "corpus/reasoning/prompts.jsonl", reasoning_prompts)

    # --- Write sentinel ---
    sentinel_body = json.dumps({
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "chat_passages": len(chat_passages),
        "summarization_docs": sum(len(v) for v in summ_docs.values()),
        "reasoning_prompts": len(reasoning_prompts),
    })
    s3.put_object(Bucket=BUCKET, Key=SENTINEL_KEY, Body=sentinel_body.encode("utf-8"),
                  ContentType="application/json")
    print(f"\nSentinel written to s3://{BUCKET}/{SENTINEL_KEY}")
    print("Corpus upload complete!")


if __name__ == "__main__":
    main()
