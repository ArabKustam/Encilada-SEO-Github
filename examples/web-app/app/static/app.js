const list = document.querySelector("#tasks");
const empty = document.querySelector("#empty");
const form = document.querySelector("#new-task");
const input = document.querySelector("#title");

async function api(path, options) {
  const response = await fetch(path, options);
  if (!response.ok) throw new Error(`${response.status} ${path}`);
  return response.status === 204 ? null : response.json();
}

function taskRow(task) {
  const item = document.createElement("li");
  item.className = task.done ? "done" : "";
  item.dataset.id = task.id;

  const toggle = document.createElement("button");
  toggle.className = "toggle";
  toggle.textContent = task.done ? "✓" : "";
  toggle.setAttribute("aria-label", task.done ? "Mark as not done" : "Mark as done");
  toggle.addEventListener("click", async () => {
    await api(`/api/tasks/${task.id}/toggle`, { method: "POST" });
    refresh();
  });

  const title = document.createElement("span");
  title.textContent = task.title;

  const remove = document.createElement("button");
  remove.className = "remove";
  remove.textContent = "×";
  remove.setAttribute("aria-label", "Delete task");
  remove.addEventListener("click", async () => {
    await api(`/api/tasks/${task.id}`, { method: "DELETE" });
    refresh();
  });

  item.append(toggle, title, remove);
  return item;
}

async function refresh() {
  const tasks = await api("/api/tasks");
  list.replaceChildren(...tasks.map(taskRow));
  empty.hidden = tasks.length > 0;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const title = input.value.trim();
  if (!title) return;
  await api("/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  input.value = "";
  refresh();
});

async function loadSuggestions() {
  const ideas = await api("/api/suggestions");
  const target = document.querySelector("#suggestions");
  for (const idea of ideas) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.textContent = idea;
    button.addEventListener("click", () => {
      input.value = idea;
      input.focus();
    });
    item.appendChild(button);
    target.appendChild(item);
  }
}

refresh();
loadSuggestions();
