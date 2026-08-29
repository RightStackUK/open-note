import type { TodoItem } from '@open-note/core';

interface TodoViewProps {
  todos: TodoItem[];
  onOpen: (path: string, line: number) => void;
  onToggle: (todo: TodoItem) => void;
}

/** Overdue and due-today deserve attention; everything else is just a date. */
function dueClass(due: string | null, today: string): string {
  if (!due) return '';
  if (due < today) return 'is-overdue';
  if (due === today) return 'is-today';
  return '';
}

export function TodoView({ todos, onOpen, onToggle }: TodoViewProps) {
  const today = new Date().toISOString().slice(0, 10);
  const open = todos.filter((t) => !t.done);
  const done = todos.filter((t) => t.done);

  return (
    <div className="todos">
      <header className="todos-head">
        <h2>Tasks</h2>
        <p className="muted-note">
          {open.length} open{done.length > 0 && `, ${done.length} done`} across your notes.
        </p>
      </header>

      {todos.length === 0 ? (
        <p className="muted-note">
          No tasks yet. Write <code>- [ ] something</code> in any note.
        </p>
      ) : (
        <ul className="todo-list">
          {[...open, ...done].map((todo) => (
            <li key={`${todo.path}:${todo.line}`} className={todo.done ? 'is-done' : ''}>
              <input
                type="checkbox"
                checked={todo.done}
                onChange={() => onToggle(todo)}
                aria-label={todo.text}
              />
              <div className="todo-body">
                <span className="todo-text">{todo.text}</span>
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
