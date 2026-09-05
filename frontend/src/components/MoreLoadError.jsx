import PageHeader from './ui/PageHeader.jsx';
import Button from './ui/Button.jsx';
import ErrorCard from './ErrorCard.jsx';

export default function MoreLoadError({ title, message, onRetry }) {
  return <div style={{ maxWidth: 680, margin: '0 auto', padding: '16px 20px var(--scroll-pad-bottom)' }}>
    <PageHeader title={title} />
    <ErrorCard message={message} />
    <Button onClick={onRetry}>Try again</Button>
  </div>;
}
