export function ResultState({ title, description, actionLabel, onAction, kind = "empty" }: {
  title: string; description?: string; actionLabel?: string | undefined; onAction?: () => void;
  kind?: "empty" | "loading" | "error";
}) {
  return <div className={`result-state result-state--${kind}`}>
    <p role={kind === "error" ? "alert" : "status"} className="result-title">{title}</p>
    {description ? <p className="muted">{description}</p> : null}
    {actionLabel && onAction ? <button type="button" className="btn btn--quiet" onClick={onAction}>{actionLabel}</button> : null}
  </div>;
}
