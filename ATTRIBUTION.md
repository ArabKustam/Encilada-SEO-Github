# Зависимости и лицензии

В код repokit не включаются зависимости с несовместимыми лицензиями (AGPL и подобные).

## Зависимости времени выполнения

| Пакет | Версия | Лицензия | Где используется |
|---|---|---|---|
| [commander](https://github.com/tj/commander.js) | 15.0.0 | MIT | разбор аргументов CLI |
| [ajv](https://github.com/ajv-validator/ajv) | 8.20.0 | MIT | валидация данных по JSON Schema |

## Зависимости разработки

| Пакет | Версия | Лицензия | Где используется |
|---|---|---|---|
| [typescript](https://github.com/microsoft/TypeScript) | 7.0.2 | Apache-2.0 | сборка и проверка типов |
| [vitest](https://github.com/vitest-dev/vitest) | 5.0.3 | MIT | тесты |
| [@types/node](https://github.com/DefinitelyTyped/DefinitelyTyped) | 20.19.43 | MIT | типы Node.js |

## Внешние инструменты

Не входят в репозиторий и не устанавливаются автоматически; `repokit doctor` только проверяет их наличие: git, ffmpeg, gh, python.
