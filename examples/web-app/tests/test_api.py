from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health():
    assert client.get("/health").json() == {"status": "ok"}


def test_task_lifecycle():
    created = client.post("/api/tasks", json={"title": "Ship it"})
    assert created.status_code == 201
    task_id = created.json()["id"]

    assert any(task["id"] == task_id for task in client.get("/api/tasks").json())

    toggled = client.post(f"/api/tasks/{task_id}/toggle")
    assert toggled.json()["done"] is True

    assert client.delete(f"/api/tasks/{task_id}").status_code == 204
    assert client.post(f"/api/tasks/{task_id}/toggle").status_code == 404


def test_empty_title_rejected():
    assert client.post("/api/tasks", json={"title": ""}).status_code == 422
