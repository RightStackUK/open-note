import type { TodoItem } from '@open-note/core';
import { useState } from 'react';

interface TodoViewProps {
  todos: TodoItem[];
  onOpen: (path: string, line: number) => void;
  onToggle: (todo: TodoItem) => void;
}

/**
 * Task text as it reads, not as it is stored.
 *
 * A task pulled out of a note keeps whatever link syntax it was written with;
 * showing `[[Reading/Books]]` in a list of things to do is noise, so the
 * brackets go and an alias wins over its target.
 */
function readable(text: string): string {
  return text.replace(/\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/g, (_, target, alias) =>
    (alias ?? target).trim(),
  );
}

/** Overdue and due-today deserve attention; everything else is just a date. */
function dueClass(due: string | null, today: string): string {
  if (!due) return '';
  if (due < today) return 'is-overdue';
  if (due === today) return 'is-today';
  return '';
}

type Filter = 'open' | 'done' | 'all';

export function TodoView({ todos, onOpen, onToggle }: TodoViewProps) {
  // Open work is what a task list is for; the rest is available, not default.
  const [filter, setFilter] = useState<Filter>('open');
  const today = new Date().toISOString().slice(0, 10);
  const open = todos.filter((t) => !t.done);
  const done = todos.filter((t) => t.done);
  const shown = filter === 'open' ? open : filter === 'done' ? done : [...open, ...done];

  return (
    <div className="todos">
      <header className="todos-head">
        <h2>Tasks</h2>
        <p className="muted-note">
          {open.length} open{done.length > 0 && `, ${done.length} done`} across your notes.
        </p>
        {todos.length > 0 && (
          <div className="segmented" role="group" aria-label="Which tasks to show">
            {(['open', 'done', 'all'] as const).map((option) => (
              <button
                key={option}
                type="button"
                className={filter === option ? 'is-on' : ''}
                aria-pressed={filter === option}
                onClick={() => setFilter(option)}
              >
                {option === 'open' ? `Open ${open.length}` : null}
                {option === 'done' ? `Done ${done.length}` : null}
                {option === 'all' ? `All ${todos.length}` : null}
              </button>
            ))}
          </div>
        )}
      </header>

      {todos.length === 0 ? (
        <p className="muted-note">
          No tasks yet. Write <code>- [ ] something</code> in any note.
        </p>
      ) : shown.length === 0 ? (
        <p className="muted-note">
          {filter === 'open' ? 'Nothing left to do.' : 'Nothing finished yet.'}
        </p>
      ) : (
        <ul className="todo-list">
          {shown.map((todo) => (
            <li key={`${todo.path}:${todo.line}`} className={todo.done ? 'is-done' : ''}>
              <input
                type="checkbox"
                checked={todo.done}
                onChange={() => onToggle(todo)}
                aria-label={readable(todo.text)}
              />
              <div className="todo-body">
                <span className="todo-text">{readable(todo.text)}</span>
                <span className="todo-meta">
                  <button
                    type="button"
                    className="linky"
                    onClick={() => onOpen(todo.path, todo.line)}
                  >
                    {todo.noteTitle}
                  </button>
                  {todo.due && (
                    <span className={`due ${dueClass(todo.due, today)}`}>{todo.due}</span>
                  )}
                  {todo.priority && (
                    <span className={`prio is-${todo.priority}`}>{todo.priority}</span>
                  )}
                  {todo.tags.map((tag) => (
                    <span key={tag} className="tag-chip">
                      #{tag}
                    </span>
                  ))}
                  {todo.people.map((person) => (
                    <span key={person} className="tag-chip">
                      @{person}
                    </span>
                  ))}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
