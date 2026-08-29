/** Daily notes: one file per day, in a predictable place. */

export interface DailyNoteSettings {
  /** Folder the daily notes live in, vault-relative. */
  folder: string;
  /** Only `YYYY-MM-DD` is supported; anything else would break sorting. */
  dateFormat: 'YYYY-MM-DD';
}

export const DEFAULT_DAILY_SETTINGS: DailyNoteSettings = {
  folder: 'daily',
  dateFormat: 'YYYY-MM-DD',
};

/** Local-time ISO date. Using UTC would put the note on the wrong day. */
export function localIsoDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function dailyNotePath(date: Date, settings: DailyNoteSettings = DEFAULT_DAILY_SETTINGS) {
  const name = `${localIsoDate(date)}.md`;
  const folder = settings.folder.replace(/^\/+|\/+$/g, '');
  return folder ? `${folder}/${name}` : name;
}

/** Starting content for a freshly created daily note. */
export function dailyNoteTemplate(date: Date): string {
  return `# ${localIsoDate(date)}\n\n`;
}
