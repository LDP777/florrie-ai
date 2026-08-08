import React from 'react';
import { createRoot } from 'react-dom/client';
import DragList, { DragHandle } from '../../src/components/ui/DragList.jsx';

const START = ['Signature brows','Brow wax','Lamination Hybrid dye','Lamination Tint','Lamination & tint','Lamination & Hybrid stain','Hybrid stain'];

function App() {
  const [items, setItems] = React.useState(START.map((n,i)=>({ id:'t'+i, name:n })));
  const [commits, setCommits] = React.useState(0);
  window.__order = () => items.map(i => i.name);
  window.__commits = () => commits;
  return (
    <div id="app-scroll" style={{ height: 420, overflowY: 'auto', padding: 8 }}>
      <DragList
        items={items}
        getKey={t => t.id}
        gap={8}
        onReorder={next => { setItems(next); setCommits(c => c + 1); window.__lastCommit = next.map(n => n.name); }}
        renderItem={(t, { handleProps, isDragging }) => (
          <div data-row={t.name} style={{ display:'flex', alignItems:'center', gap:8, height:56, marginBottom:8, background:'#FFFCF9', border:'1px solid #E8DDD4', borderRadius:16, padding:'0 8px' }}>
            <DragHandle handleProps={handleProps} label={`Reorder ${t.name}`} />
            <span>{t.name}</span>
          </div>
        )}
      />
    </div>
  );
}
createRoot(document.getElementById('root')).render(<App />);
