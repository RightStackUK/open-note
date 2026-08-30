/** Render a unified diff with per-line colouring. */
export function DiffView({ diff }: { diff: string }) {
  if (!diff.trim()) {
    return <p className="muted-note">No changes in this note.</p>;
  }

  const lines = diff.split('\n');
  return (
    <pre className="diff">
      {lines.map((line, i) => {
        // Hunk and file headers are structure, not content.
        const kind =
          line.startsWith('+++') || line.startsWith('---')
            ? 'meta'
            : line.startsWith('@@')
              ? 'hunk'
              : line.startsWith('+')
                ? 'add'
                : line.startsWith('-')
                  ? 'del'
                  : line.startsWith('diff ') || line.startsWith('index ')
                    ? 'meta'
                    : 'ctx';
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: diff lines have no stable id
          <span key={i} className={`diff-line is-${kind}`}>
            {line || ' '}
          </span>
        );
      })}
    </pre>
  );
}
