import { useId, useState } from 'react';
import Button from './ui/Button.jsx';

// Keep the complete saved text. Folding long outlines keeps dates and booking
// actions within reach, while rendering plain text preserves React's escaping.
export default function CourseDescription({ text, style }) {
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  if (!text) return null;
  const long = text.length > 600 || text.split('\n').length > 8;
  return <div style={{ minWidth: 0 }}>
    <p id={id} style={{
      ...style, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
      ...(long && !expanded ? { display: '-webkit-box', WebkitLineClamp: 6, WebkitBoxOrient: 'vertical', overflow: 'hidden' } : {}),
    }}>{text}</p>
    {long && <Button variant="quiet" size="sm" aria-expanded={expanded} aria-controls={id}
      onClick={() => setExpanded(value => !value)} style={{ marginBottom: 12 }}>
      {expanded ? 'Show less' : 'Read full description'}
    </Button>}
  </div>;
}
