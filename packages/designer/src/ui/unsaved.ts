/**
 * The step whose edits are not saved yet, if any. Leaving it (for another step or example, or by closing the page)
 * asks first, since the edits would be gone.
 */
export const unsaved = { step: '' };

/** Whether to go on and leave the step being edited: yes when nothing is unsaved, or when the editor says so. */
export function mayLeave(): boolean {
  if (!unsaved.step || window.confirm(`${unsaved.step} has changes that are not saved. Leave without them?`)) {
    unsaved.step = '';
    return true;
  }
  return false;
}

// Closing or reloading the page asks too, in the browser's own words.
window.addEventListener('beforeunload', (e) => {
  if (unsaved.step) e.preventDefault();
});
