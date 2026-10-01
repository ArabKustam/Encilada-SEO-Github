# Зависимости и лицензии

В код repokit не включаются зависимости с несовместимыми лицензиями (AGPL и подобные).

## Зависимости времени выполнения

| Пакет | Версия | Лицензия | Где используется |
|---|---|---|---|
| [commander](https://github.com/tj/commander.js) | 15.0.0 | MIT | разбор аргументов CLI |
| [ajv](https://github.com/ajv-validator/ajv) | 8.20.0 | MIT | валидация данных по JSON Schema |
| [yaml](https://github.com/eemeli/yaml) | 2.9.1 | ISC | сценарии `capture` |
| [playwright](https://github.com/microsoft/playwright) | 1.63.0 | Apache-2.0 | управление браузером при записи |
| [react](https://github.com/facebook/react), react-dom | 19.3.0 | MIT | композиция ролика в `studio` |
| [remotion](https://github.com/remotion-dev/remotion), @remotion/bundler, @remotion/renderer | 4.0.531 | **Remotion License** (не open source) | покадровый рендер в `studio` |
| [@remotion/three](https://github.com/remotion-dev/remotion/tree/main/packages/three) | 4.0.531 | MIT | связка Remotion и three.js |
| [three](https://github.com/mrdoob/three.js) | 0.186.1 | MIT | 3D-сцены пресетов |
| [@react-three/fiber](https://github.com/pmndrs/react-three-fiber) | 9.8.1 | MIT | описание 3D-сцен компонентами React |

### Лицензия Remotion

Remotion распространяется не под свободной лицензией. Бесплатное использование разрешено частным лицам, некоммерческим
организациям и коммерческим компаниям до 3 сотрудников; остальным требуется платная лицензия. Актуальные условия:
<https://www.remotion.dev/license>. repokit не включает код Remotion в репозиторий — пакеты ставятся как зависимости,
и соблюдение условий лежит на том, кто запускает `repokit studio render`. Остальные сервисы от Remotion не зависят.

## Зависимости разработки

| Пакет | Версия | Лицензия | Где используется |
|---|---|---|---|
| [typescript](https://github.com/microsoft/TypeScript) | 7.0.2 | Apache-2.0 | сборка и проверка типов |
| [vitest](https://github.com/vitest-dev/vitest) | 5.0.3 | MIT | тесты |
| [@types/node](https://github.com/DefinitelyTyped/DefinitelyTyped) | 20.19.43 | MIT | типы Node.js |
| @types/react, @types/react-dom, @types/three, @types/pngjs | — | MIT | типы |
| [pixelmatch](https://github.com/mapbox/pixelmatch) | 7.2.0 | ISC | сравнение кадров в снапшот-тестах |
| [pngjs](https://github.com/pngjs/pngjs) | 7.0.0 | MIT | чтение PNG в снапшот-тестах |

## Внешние инструменты

Не входят в репозиторий и не устанавливаются автоматически; `repokit doctor` только проверяет их наличие: git, ffmpeg, gh, python,
браузер семейства Chromium (Google Chrome, Edge или сборка Playwright).

GIF кодируется фильтрами палитры ffmpeg. gifski не используется: его лицензия AGPL.

Оформление ролика (окно-рамка, курсор, фоны) нарисовано в коде repokit; сторонние изображения, логотипы и код других
программ записи экрана не используются.

## 3D-модели и изображения

Внешних 3D-моделей, текстур и шрифтов в репозитории нет: устройства в `presets/3d/` построены процедурно из простых фигур
и не воспроизводят конкретные продукты. Тестовые изображения в `tests/fixtures/slots/` сгенерированы фильтром `testsrc2` из ffmpeg.
