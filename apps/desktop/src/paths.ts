/**
 * Note-relative ↔ vault-relative paths.
 *
 * The pair moved into `@open-note/core` when the import pipeline needed to
 * *write* such references as well as read them; this re-export keeps the app's
 * call sites — and the test that pins the behaviour — importing from one place.
 */

export { relativeFrom, resolveAgainst } from '@open-note/core';
