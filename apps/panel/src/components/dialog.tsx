import { X } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef } from "react";
import { Button } from "./ui";

/** Native modal `<dialog>`: focus trap, Esc and inert background for free. */
function useModal(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDialogElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      if (typeof el.showModal === "function") el.showModal();
      else el.setAttribute("open", "");
    } else if (!open && el.open) {
      if (typeof el.close === "function") el.close();
      else el.removeAttribute("open");
    }
  }, [open]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const handle = () => onCloseRef.current();
    const cancel = (e: Event) => {
      e.preventDefault();
      onCloseRef.current();
    };
    // A click whose target is the <dialog> itself landed on the backdrop.
    const backdrop = (e: MouseEvent) => {
      if (e.target === el) onCloseRef.current();
    };
    el.addEventListener("close", handle);
    el.addEventListener("cancel", cancel);
    el.addEventListener("click", backdrop);
    return () => {
      el.removeEventListener("close", handle);
      el.removeEventListener("cancel", cancel);
      el.removeEventListener("click", backdrop);
    };
  }, []);

  return ref;
}

export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  danger,
  busy,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: ReactNode;
  children?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const ref = useModal(open, onClose);
  const titleId = useId();
  return (
    <dialog ref={ref} className="dialog" aria-labelledby={titleId}>
      {open && (
        <>
          <div className="dialog__body">
            <h2 className="dialog__title" id={titleId}>
              {title}
            </h2>
            {children && <div className="dialog__text">{children}</div>}
          </div>
          <div className="dialog__foot">
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              取消
            </Button>
            <Button variant={danger ? "danger" : "primary"} onClick={onConfirm} busy={busy} autoFocus>
              {confirmLabel}
            </Button>
          </div>
        </>
      )}
    </dialog>
  );
}

export function Modal({
  open,
  title,
  children,
  footer,
  wide,
  onClose,
}: {
  open: boolean;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  onClose: () => void;
}) {
  const ref = useModal(open, onClose);
  const titleId = useId();
  return (
    <dialog ref={ref} className={wide ? "dialog dialog--wide" : "dialog"} aria-labelledby={titleId}>
      {open && (
        <>
          <div className="dialog__body">
            <h2 className="dialog__title" id={titleId}>
              {title}
            </h2>
            {children}
          </div>
          {footer && <div className="dialog__foot">{footer}</div>}
        </>
      )}
    </dialog>
  );
}

export function Drawer({
  open,
  title,
  children,
  actions,
  onClose,
}: {
  open: boolean;
  title: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  onClose: () => void;
}) {
  const ref = useModal(open, onClose);
  const titleId = useId();
  return (
    <dialog ref={ref} className="drawer" aria-labelledby={titleId}>
      {open && (
        <>
          <div className="drawer__head">
            <h2 className="drawer__title" id={titleId}>
              {title}
            </h2>
            {actions}
            <Button variant="ghost" iconOnly icon={X} label="關閉" onClick={onClose} />
          </div>
          <div className="drawer__body">{children}</div>
        </>
      )}
    </dialog>
  );
}
