"""In-memory task storage. Data lives only while the process runs."""
from dataclasses import dataclass, field
from itertools import count


@dataclass
class StoredTask:
    id: int
    title: str
    done: bool = False


@dataclass
class TaskStore:
    _tasks: dict[int, StoredTask] = field(default_factory=dict)
    _ids: count = field(default_factory=lambda: count(1))

    def all(self) -> list[StoredTask]:
        return list(self._tasks.values())

    def add(self, title: str) -> StoredTask:
        task = StoredTask(id=next(self._ids), title=title)
        self._tasks[task.id] = task
        return task

    def toggle(self, task_id: int) -> StoredTask | None:
        task = self._tasks.get(task_id)
        if task:
            task.done = not task.done
        return task

    def remove(self, task_id: int) -> bool:
        return self._tasks.pop(task_id, None) is not None
