import { useState } from 'react';

// Nested optional chains like copy-requisition's invoice page (BUG-31).
export function describeInvoice(invoice, softco = 'SoftCo') {
  return invoice?.SOURCE?.toLowerCase().includes(softco?.toLowerCase()) ? 'SoftCo' : 'Other';
}

export default function App({ user }) {
  const [count, setCount] = useState(0);
  return (
    <div>
      <h1>Hello {user?.name ?? 'guest'}</h1>
      <button onClick={() => setCount(count + 1)}>Clicked {count}</button>
    </div>
  );
}
