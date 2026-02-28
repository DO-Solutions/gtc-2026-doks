interface InfoIconProps {
  id: string;
  description: string;
  openPopover: string | null;
  setOpenPopover: (v: string | null) => void;
}

export function InfoIcon({ id, description, openPopover, setOpenPopover }: InfoIconProps) {
  return (
    <>
      <span
        className="metric-info"
        onClick={(e) => { e.stopPropagation(); setOpenPopover(openPopover === id ? null : id); }}
      >&#9432;</span>
      {openPopover === id && (
        <div className="metric-popover">{description}</div>
      )}
    </>
  );
}
