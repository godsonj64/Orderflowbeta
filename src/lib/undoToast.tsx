import React from 'react';
import toast from 'react-hot-toast';

/**
 * A toast with an "Undo" button. Staff work fast on touch screens; every one-tap action
 * that changes an order or the store gets a few seconds in which it can be taken back.
 */
export function undoToast(id: string, message: React.ReactNode, onUndo: () => void, duration = 6000) {
  toast(
    (t) => (
      <span className="flex items-center justify-between gap-3 w-full">
        <span className="min-w-0 break-words leading-snug">{message}</span>
        <button
          type="button"
          onClick={() => {
            toast.dismiss(t.id);
            onUndo();
          }}
          className="shrink-0 px-3 py-1.5 rounded-lg bg-[#F39120] hover:opacity-95 font-extrabold text-xs uppercase tracking-wider text-[#111315] active:scale-95 transition"
        >
          Undo
        </button>
      </span>
    ),
    { id, duration },
  );
}
