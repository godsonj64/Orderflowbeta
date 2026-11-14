import React from 'react';
import toast from 'react-hot-toast';

/**
 * A toast with an "Undo" button. Staff work fast on touch screens; every one-tap action
 * that changes an order or the store gets a few seconds in which it can be taken back.
 */
export function undoToast(id: string, message: React.ReactNode, onUndo: () => void, duration = 6000) {
  toast(
    (t) => (
      <span className="flex items-center gap-3">
        <span>{message}</span>
        <button
          type="button"
          onClick={() => {
            toast.dismiss(t.id);
            onUndo();
          }}
          className="shrink-0 -my-1 -mr-1 px-3 py-2 rounded-xl bg-white/15 font-bold text-amber-300 active:scale-95"
        >
          Undo
        </button>
      </span>
    ),
    { id, duration },
  );
}
