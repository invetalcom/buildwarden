import type { KeyboardEvent } from "react";

export const listboxOptions = (listbox: HTMLElement): HTMLElement[] => Array.from(listbox.querySelectorAll<HTMLElement>('[role="option"]:not(:disabled)'));

/**
 * Keyboard behavior of a `role="listbox"` whose options are buttons: Up and Down move the focus, Home and End jump to the ends.
 * Enter and Space already choose the focused option because it is a button.
 * Returns false when the focus was on the first option and Up was pressed, so the caller can hand the focus back to a filter field.
 */
export const moveListboxFocus = (event: KeyboardEvent<HTMLElement>): boolean => {
  const options = listboxOptions(event.currentTarget);
  if (options.length === 0) return true;
  const current = options.findIndex((option) => option === document.activeElement);
  const last = options.length - 1;
  let next: number;
  if (event.key === "ArrowDown") next = Math.min(current + 1, last);
  else if (event.key === "ArrowUp") next = current - 1;
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = last;
  else return true;
  event.preventDefault();
  if (next < 0) return current !== 0;
  options[next]?.focus();
  return true;
};
