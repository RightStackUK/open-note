/**
 * Emoji shortcodes, for `:` completion and for per-tag icons.
 *
 * Deliberately a curated list rather than a full Unicode table. The complete
 * set is some 1,800 entries and several hundred kilobytes, and it would be
 * loaded on every keystroke of a `:` to offer choices nobody scrolls to. These
 * are the ones people actually type in notes, and every (shortcode, character)
 * pair matches GitHub's gemoji table exactly, so a shortcode learned here means
 * the same thing on the forge.
 *
 * It lives in `core` rather than in the editor because the tag-icon picker
 * needs exactly the same table, and two lists would drift.
 */

export interface Emoji {
  /** GitHub-style shortcode, without the surrounding colons. */
  shortcode: string;
  char: string;
  /** Extra words the picker should match on. */
  keywords?: string[];
}

export const EMOJI: Emoji[] = [
  // Status and progress — by far the most used in notes and todo lists.
  { shortcode: 'white_check_mark', char: '✅', keywords: ['done', 'tick', 'check'] },
  { shortcode: 'heavy_check_mark', char: '✔️', keywords: ['done', 'tick'] },
  { shortcode: 'x', char: '❌', keywords: ['no', 'fail', 'cross'] },
  { shortcode: 'warning', char: '⚠️', keywords: ['caution', 'careful'] },
  { shortcode: 'question', char: '❓', keywords: ['unsure', 'ask'] },
  { shortcode: 'exclamation', char: '❗', keywords: ['important'] },
  { shortcode: 'construction', char: '🚧', keywords: ['wip', 'progress', 'blocked'] },
  { shortcode: 'hourglass_flowing_sand', char: '⏳', keywords: ['waiting', 'pending'] },
  { shortcode: 'checkered_flag', char: '🏁', keywords: ['finish', 'end'] },
  { shortcode: 'rocket', char: '🚀', keywords: ['ship', 'launch', 'release'] },
  { shortcode: 'fire', char: '🔥', keywords: ['urgent', 'hot'] },
  { shortcode: 'sparkles', char: '✨', keywords: ['new', 'feature'] },
  { shortcode: 'bug', char: '🐛', keywords: ['defect', 'issue'] },
  { shortcode: 'wrench', char: '🔧', keywords: ['fix', 'tool', 'config'] },
  { shortcode: 'hammer', char: '🔨', keywords: ['build', 'tool'] },
  { shortcode: 'zap', char: '⚡', keywords: ['fast', 'performance'] },
  { shortcode: 'lock', char: '🔒', keywords: ['secure', 'private'] },
  { shortcode: 'unlock', char: '🔓', keywords: ['open', 'public'] },
  { shortcode: 'key', char: '🔑', keywords: ['password', 'secret'] },

  // Notes, writing and reference.
  { shortcode: 'memo', char: '📝', keywords: ['note', 'write', 'pencil'] },
  { shortcode: 'pencil2', char: '✏️', keywords: ['write', 'edit'] },
  { shortcode: 'book', char: '📖', keywords: ['read', 'docs'] },
  { shortcode: 'books', char: '📚', keywords: ['library', 'reading'] },
  { shortcode: 'bookmark', char: '🔖', keywords: ['save', 'later'] },
  { shortcode: 'clipboard', char: '📋', keywords: ['list', 'copy'] },
  { shortcode: 'page_facing_up', char: '📄', keywords: ['document', 'file'] },
  { shortcode: 'file_folder', char: '📁', keywords: ['folder', 'directory'] },
  { shortcode: 'paperclip', char: '📎', keywords: ['attachment'] },
  { shortcode: 'link', char: '🔗', keywords: ['url', 'reference'] },
  { shortcode: 'label', char: '🏷️', keywords: ['tag'] },
  { shortcode: 'mag', char: '🔍', keywords: ['search', 'find'] },
  { shortcode: 'pushpin', char: '📌', keywords: ['pin', 'important'] },
  { shortcode: 'calendar', char: '📆', keywords: ['date', 'schedule'] },
  { shortcode: 'alarm_clock', char: '⏰', keywords: ['reminder', 'deadline'] },
  { shortcode: 'chart_with_upwards_trend', char: '📈', keywords: ['growth', 'metrics'] },
  { shortcode: 'bar_chart', char: '📊', keywords: ['data', 'stats'] },

  // Thinking and communication.
  { shortcode: 'bulb', char: '💡', keywords: ['idea', 'tip'] },
  { shortcode: 'brain', char: '🧠', keywords: ['think', 'learn'] },
  { shortcode: 'thought_balloon', char: '💭', keywords: ['idea', 'maybe'] },
  { shortcode: 'speech_balloon', char: '💬', keywords: ['comment', 'chat'] },
  { shortcode: 'telephone', char: '☎️', keywords: ['call', 'phone'] },
  { shortcode: 'email', char: '✉️', keywords: ['mail', 'message'] },
  { shortcode: 'loudspeaker', char: '📢', keywords: ['announce', 'notify'] },
  { shortcode: 'eyes', char: '👀', keywords: ['review', 'look'] },
  { shortcode: 'handshake', char: '🤝', keywords: ['agree', 'deal', 'meeting'] },

  // Reactions.
  { shortcode: 'thumbsup', char: '👍', keywords: ['yes', 'good', 'approve'] },
  { shortcode: 'thumbsdown', char: '👎', keywords: ['no', 'bad'] },
  { shortcode: 'tada', char: '🎉', keywords: ['celebrate', 'done', 'party'] },
  { shortcode: 'star', char: '⭐', keywords: ['favourite', 'favorite'] },
  { shortcode: 'heart', char: '❤️', keywords: ['love', 'like'] },
  { shortcode: 'smile', char: '😄', keywords: ['happy'] },
  { shortcode: 'thinking', char: '🤔', keywords: ['hmm', 'unsure'] },
  { shortcode: 'cry', char: '😢', keywords: ['sad'] },
  { shortcode: 'grimacing', char: '😬', keywords: ['awkward', 'yikes'] },
  { shortcode: 'facepalm', char: '🤦', keywords: ['oops'] },
  { shortcode: 'clap', char: '👏', keywords: ['applause', 'nice'] },
  { shortcode: 'pray', char: '🙏', keywords: ['thanks', 'please'] },
  { shortcode: 'muscle', char: '💪', keywords: ['strong', 'effort'] },
  { shortcode: 'wave', char: '👋', keywords: ['hello', 'bye'] },
  { shortcode: 'point_right', char: '👉', keywords: ['see', 'next'] },

  // Technical.
  { shortcode: 'computer', char: '💻', keywords: ['laptop', 'code'] },
  { shortcode: 'gear', char: '⚙️', keywords: ['settings', 'config'] },
  { shortcode: 'package', char: '📦', keywords: ['release', 'dependency'] },
  { shortcode: 'floppy_disk', char: '💾', keywords: ['save', 'storage'] },
  { shortcode: 'cloud', char: '☁️', keywords: ['remote', 'sync'] },
  { shortcode: 'globe_with_meridians', char: '🌐', keywords: ['web', 'internet'] },
  { shortcode: 'satellite', char: '📡', keywords: ['network', 'signal'] },
  { shortcode: 'test_tube', char: '🧪', keywords: ['test', 'experiment'] },
  { shortcode: 'microscope', char: '🔬', keywords: ['inspect', 'research'] },
  { shortcode: 'robot', char: '🤖', keywords: ['bot', 'automation', 'ai'] },
  { shortcode: 'recycle', char: '♻️', keywords: ['refactor', 'reuse'] },
  { shortcode: 'boom', char: '💥', keywords: ['crash', 'breaking'] },
  { shortcode: 'skull', char: '💀', keywords: ['dead', 'deprecated'] },

  // Places, time and living.
  { shortcode: 'house', char: '🏠', keywords: ['home'] },
  { shortcode: 'office', char: '🏢', keywords: ['work', 'building'] },
  { shortcode: 'airplane', char: '✈️', keywords: ['travel', 'flight'] },
  { shortcode: 'car', char: '🚗', keywords: ['drive', 'travel'] },
  { shortcode: 'shopping_cart', char: '🛒', keywords: ['buy', 'shopping'] },
  { shortcode: 'coffee', char: '☕', keywords: ['break', 'morning'] },
  { shortcode: 'pizza', char: '🍕', keywords: ['food', 'lunch'] },
  { shortcode: 'birthday', char: '🎂', keywords: ['cake', 'celebrate'] },
  { shortcode: 'gift', char: '🎁', keywords: ['present'] },
  { shortcode: 'money_with_wings', char: '💸', keywords: ['spend', 'cost'] },
  { shortcode: 'dollar', char: '💵', keywords: ['money', 'price'] },
  { shortcode: 'sunny', char: '☀️', keywords: ['weather', 'day'] },
  { shortcode: 'crescent_moon', char: '🌙', keywords: ['night', 'sleep', 'moon'] },
  { shortcode: 'seedling', char: '🌱', keywords: ['grow', 'new', 'plant'] },
  { shortcode: 'dog', char: '🐶', keywords: ['pet'] },
  { shortcode: 'cat', char: '🐱', keywords: ['pet'] },
  { shortcode: 'heavy_plus_sign', char: '➕', keywords: ['add', 'more'] },
  { shortcode: 'heavy_minus_sign', char: '➖', keywords: ['remove', 'less'] },
  { shortcode: 'arrow_right', char: '➡️', keywords: ['next', 'then'] },
  { shortcode: 'arrow_left', char: '⬅️', keywords: ['back', 'previous'] },
];

/**
 * Emoji matching `query`, best first.
 *
 * Ranks an exact shortcode above a shortcode prefix, a prefix above a
 * substring, and a keyword match last — so typing `:x` offers `❌` rather than
 * whatever else happens to contain an x.
 */
export function searchEmoji(query: string, limit = 30, table: Emoji[] = EMOJI): Emoji[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return table.slice(0, limit);

  const scored: Array<{ emoji: Emoji; score: number }> = [];
  for (const emoji of table) {
    const code = emoji.shortcode;
    let score = 0;
    if (code === needle) score = 100;
    else if (code.startsWith(needle)) score = 80;
    else if (code.includes(needle)) score = 50;
    else if (emoji.keywords?.some((k) => k === needle)) score = 40;
    else if (emoji.keywords?.some((k) => k.startsWith(needle))) score = 30;
    else if (emoji.keywords?.some((k) => k.includes(needle))) score = 10;
    if (score > 0) scored.push({ emoji, score });
  }

  return scored
    .sort((a, b) => b.score - a.score || a.emoji.shortcode.localeCompare(b.emoji.shortcode))
    .slice(0, limit)
    .map((s) => s.emoji);
}
