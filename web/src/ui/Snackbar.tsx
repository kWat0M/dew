import { useEffect } from 'react';
import './Snackbar.css';

/** MD3 の Snackbar。数秒で消える */
export function Snackbar({ message, onClose }: { message: string | null; onClose: () => void }) {
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(onClose, 5000);
    return () => clearTimeout(t);
  }, [message, onClose]);
  if (!message) return null;
  return (
    <div className="snackbar" role="status">
      {message}
    </div>
  );
}
