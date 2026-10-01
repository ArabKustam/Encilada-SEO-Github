# scan — анализ репозитория

Собирает факты о проекте и проверяет утверждения README по коду. Не обращается к сети и не меняет исходники.

## Команды

| Команда | Результат | Код выхода 1, если |
|---|---|---|
| `scan init [--write-gitignore]` | папка `.repokit/` | — |
| `scan audit` | `.repokit/scan.json` | в аудите есть замечания уровня `error` |
| `scan context` | `.repokit/context.md` | — |
| `scan topics` | список topics в `data.topics` | — |
| `scan claims extract` | `.repokit/claims.json` | — |
| `scan claims pin [--force]` | хэши доказательств в `claims.json` | доказательство указывает на несуществующие строки |
| `scan claims check` | отчёт в `data.results` | утверждение не подтверждено или код изменился |

Общие флаги: `--repo <path>`, `--json`, `--dry-run`.

## scan.json

Схема: [schemas/scan.schema.json](../schemas/scan.schema.json).

- `project` — имя, типы (`static-site`, `node-web`, `python-api`, `data-app`, `cli`, `docker`, `unknown`), языки, фреймворки, команды `install` / `run` / `test`.
- `entrypoints`, `routes`, `models` — с файлом, строкой и `confidence` от 0 до 1.
- `mocks` — строки с `TODO`/`FIXME`, словами `mock`, `fake`, `dummy`, `stub`, `hardcoded`, `NotImplementedError`, `lorem ipsum`. Тестовые файлы не учитываются.
- `keyFiles` — файлы, которые стоит прочитать в первую очередь, с причинами.
- `repoHealth` и `audit` — состояние репозитория и замечания (`error` / `warn` / `info`).
- `treeSha256` — хэш дерева файлов; при неизменном репозитории результат побайтно тот же.

Список файлов берётся из git (с учётом `.gitignore`), а вне git-репозитория — обходом папок.
Служебные файлы в git (`node_modules`, `.env`, `__pycache__`, `*.log`) дают ошибку аудита только если они закоммичены.

### Что распознаётся

| Что | Как |
|---|---|
| FastAPI / Flask | `app = FastAPI(...)`, `@app.get("/x")`, `@app.route("/x", methods=[...])` |
| Express / Fastify | `app.get("/x", ...)`, `router.post("/x", ...)`; без зависимости в `package.json` — `confidence` 0.4 |
| Next.js | файлы в `pages/` и `app/**/page.*` |
| Статический сайт | `index.html` в корне при отсутствии серверного фреймворка |
| Модели | Pydantic, SQLModel, SQLAlchemy, Prisma |
| CLI | `bin` в `package.json`, `[project.scripts]`, Python-файл с `argparse`/`click`/`typer` и `__main__` |

Это эвристики по строкам, а не полноценный разбор кода: нестандартная регистрация роутов может быть не найдена.

## claims.json

Схема: [schemas/claims.schema.json](../schemas/claims.schema.json).

```json
{
  "schemaVersion": 1,
  "claims": [
    {
      "id": "c2",
      "text": "Отметка задач выполненными",
      "status": "implemented",
      "source": "readme",
      "evidence": [{ "file": "app/store.py", "lines": [26, 30], "snippetSha256": "…" }]
    }
  ]
}
```

Статусы: `implemented`, `partial`, `mock`, `unverified`. Первые два обязаны иметь доказательство.
Хэш считается по указанным строкам (окончания строк и хвостовые пробелы нормализуются), поэтому правки
в другом месте файла ничего не ломают, только если не сдвигают строки: после сдвига доказательство нужно указать заново.
`extract` при повторном запуске добавляет только новые утверждения и не трогает уже размеченные.
