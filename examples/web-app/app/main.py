"""Taskboard — a small FastAPI app used as a repokit fixture."""
from pathlib import Path

from fastapi import FastAPI, HTTPException, Response
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .store import TaskStore

STATIC_DIR = Path(__file__).parent / "static"
MAX_TITLE_LENGTH = 120

app = FastAPI(title="Taskboard")
store = TaskStore()
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


class TaskIn(BaseModel):
    title: str = Field(min_length=1, max_length=MAX_TITLE_LENGTH)


class Task(BaseModel):
    id: int
    title: str
    done: bool = False


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/tasks")
def list_tasks() -> list[Task]:
    return [Task(**vars(task)) for task in store.all()]


@app.post("/api/tasks", status_code=201)
def create_task(body: TaskIn) -> Task:
    return Task(**vars(store.add(body.title.strip())))


@app.post("/api/tasks/{task_id}/toggle")
def toggle_task(task_id: int) -> Task:
    task = store.toggle(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    return Task(**vars(task))


@app.delete("/api/tasks/{task_id}", status_code=204)
def delete_task(task_id: int) -> Response:
    if not store.remove(task_id):
        raise HTTPException(status_code=404, detail="Task not found")
    return Response(status_code=204)


@app.get("/api/suggestions")
def suggestions() -> list[str]:
    # TODO: replace with a real model. These suggestions are hardcoded demo data.
    return ["Write the README", "Record a demo", "Deploy the app"]
