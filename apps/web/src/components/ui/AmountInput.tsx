import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState, type InputHTMLAttributes } from "react";
import { amountCaret, groupAmount, ungroupAmount } from "../../lib/amount-input.ts";

/** Controlled monetary input: grouped presentation, unchanged ungrouped parser/API contract. */
export const AmountInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function AmountInput({ value = "", onChange, placeholder, ...props }, ref) {
    const input = useRef<HTMLInputElement>(null);
    const caret = useRef<number | null>(null);
    const [, refresh] = useState(0);
    useImperativeHandle(ref, () => input.current!);
    const display = groupAmount(String(value));
    useLayoutEffect(() => {
      if (caret.current !== null && input.current === document.activeElement) {
        const position = amountCaret(display, caret.current);
        input.current?.setSelectionRange(position, position);
      }
      caret.current = null;
    });
    return <input {...props} ref={input} type="text" dir="ltr" value={display} placeholder={placeholder === undefined ? undefined : groupAmount(placeholder)}
      onChange={event => {
        const element = event.currentTarget;
        caret.current = ungroupAmount(element.value.slice(0, element.selectionStart ?? element.value.length)).length;
        element.value = ungroupAmount(element.value);
        onChange?.(event);
        refresh(n => n + 1);
      }} />;
  },
);
