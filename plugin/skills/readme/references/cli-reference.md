# Command reference

Generated from `repokit --help` by `scripts/build-plugin.mjs`; do not edit by hand.

Every command accepts `--json` (one JSON envelope on stdout), and most accept `--repo <path>` (default: current
directory), `--dry-run` (write nothing) and `--verbose`. Only the other flags are listed below. Descriptions are in
Russian, as the tool prints them.

## scan

анализ репозитория: факты, аудит, утверждения README

- `repokit scan audit` — собрать факты о проекте и замечания → .repokit/scan.json
- `repokit scan context` — краткая выжимка репозитория для модели → .repokit/context.md
- `repokit scan topics` — предложить GitHub topics по обнаруженному стеку
- `repokit scan init` — создать .repokit/ в целевом репозитории
  - `--write-gitignore` — добавить .repokit/ в .gitignore
- `repokit scan claims extract` — извлечь утверждения из README → .repokit/claims.json
- `repokit scan claims pin` — зафиксировать хэши строк-доказательств
  - `--force` — перезаписать уже зафиксированные хэши
- `repokit scan claims check` — проверить, что доказательства существуют и код не изменился

## capture

запись реального демо: веб-приложение по сценарию, скриншот страницы, вывод

- `repokit capture scenario draft` — каркас сценария из результатов scan → .repokit/capture/scenario.draft.yaml
- `repokit capture scenario validate` — проверить сценарий по схеме
  - `--scenario <file>` — файл сценария (YAML)
- `repokit capture run` — записать видео, лог событий и скриншоты по меткам
  - `--scenario <file>` — файл сценария (YAML)
- `repokit capture shots` — скриншоты по меткам сценария в нескольких размерах и темах
  - `--scenario <file>` — файл сценария (YAML)
  - `--sizes <list>` — размеры через запятую: desktop, tablet, mobile (default: "desktop")
  - `--themes <list>` — темы через запятую: light, dark (default: "light")
  - `--out <dir>` — папка для результата (по умолчанию внутри .repokit/capture/)
- `repokit capture screenshot` — один скриншот страницы без сценария → docs/assets/screenshot.png
  - `--url <url>` — адрес страницы, например http://localhost:8000/
  - `--start <command>` — команда запуска приложения, если оно ещё не запущено
  - `--wait-for <selector>` — дождаться появления элемента
  - `--wait <ms>` — пауза перед снимком, мс (по умолчанию 400)
  - `--size <name>` — размер окна: desktop, tablet, mobile или ШИРИНАxВЫСОТА (default: "desktop")
  - `--themes <list>` — темы через запятую: light, dark; тёмный кадр получает суффикс -dark (default: "light")
  - `--selector <css>` — снять только этот элемент
  - `--full-page` — снять страницу целиком, а не только видимую часть
  - `--demo-data` — в кадре демонстрационные данные — пометить это в записи о происхождении
  - `--out <file>` — куда записать PNG
- `repokit capture terminal` — выполнить команду и сохранить её настоящий вывод картинкой →
  - `--out <file>` — куда записать SVG; тёмный вариант получает суффикс -dark
  - `--title <text>` — заголовок окна (по умолчанию — сама команда)
  - `--cols <n>` — ширина терминала в символах (по умолчанию 88)
  - `--max-lines <n>` — сколько строк вывода показать (по умолчанию 30)
  - `--timeout <sec>` — сколько ждать завершения команды (по умолчанию 30)

## studio

монтаж записей: оформление, авто-зум, 3D-пресеты, GIF

- `repokit studio styles` — список 2D-стилей оформления
- `repokit studio presets list` — все пресеты, их слоты и соотношения сторон
- `repokit studio presets preview` — описание пресета и путь к его preview.gif
- `repokit studio scene init` — заготовка сцены из записи: авто-камера и эффекты по кликам включены
  - `--capture <run>` — запись capture: идентификатор или latest (default: "latest")
  - `--media <file>` — вместо записи — произвольное видео или изображение из репозитория
  - `--device <name>` — устройство: browser, laptop, phone, screen (default: "browser")
  - `--out <file>` — куда сохранить сцену (default: "demo.scene.json")
  - `--force` — перезаписать существующий файл
- `repokit studio scene templates` — готовые постановки: смена страниц, раскладки с пролётом камеры, движения одного
- `repokit studio scene make` — собрать сцену по шаблону из скриншотов страниц
  - `--pages <files>` — скриншоты или записи страниц через запятую, в порядке показа; без флага берутся записанные скриншоты проекта
  - `--device <name>` — устройство: browser, laptop, phone, screen (default: "browser")
  - `--background <name>` — фон: light, dark, glass, sunset, mint, mono (default: "light")
  - `--hold <sec>` — сколько секунд страница стоит впереди (default: "1.8")
  - `--move <sec>` — сколько секунд длится смена страницы (default: "0.9")
  - `--duration <sec>` — длина сцены с одной страницей (default: "6")
  - `--template <name>` — шаблон; см. studio scene templates
  - `--out <file>` — куда сохранить сцену (default: "pages.scene.json")
  - `--force` — перезаписать существующий файл
- `repokit studio scene gallery` — по одному кадру каждого шаблона на скриншотах проекта →
  - `--pages <files>` — скриншоты или записи страниц через запятую, в порядке показа; без флага берутся записанные скриншоты проекта
  - `--device <name>` — устройство: browser, laptop, phone, screen (default: "browser")
  - `--background <name>` — фон: light, dark, glass, sunset, mint, mono (default: "light")
  - `--hold <sec>` — сколько секунд страница стоит впереди (default: "1.8")
  - `--move <sec>` — сколько секунд длится смена страницы (default: "0.9")
  - `--duration <sec>` — длина сцены с одной страницей (default: "6")
  - `--gl <backend>` — как рисовать WebGL: angle, swangle, swiftshader, egl, vulkan
- `repokit studio scene validate` — проверить сцену: схема, файлы, длительность, ссылки на объекты
  - `--scene <file>` — файл сцены
- `repokit studio explain` — видеоразбор устройства проекта: карточки модулей и сервисов, связи из кода,
  - `--out <file>` — куда сохранить сцену разбора (default: "explain.scene.json")
  - `--theme <name>` — оформление: light, dark, glass, sunset, mint, mono (default: "dark")
  - `--detail <level>` — overview — модули и связи; full — ещё скриншот интерфейса, модели данных и путь каждого запроса по коду (default: "overview")
  - `--force` — перезаписать существующий файл
- `repokit studio icons` — значки для карточек сцен
- `repokit studio deck init` — собрать черновик слайдов из полей автора, утверждений, технологий и скриншотов
  - `--kind <kind>` — что собирать: slides, banner, wide (default: "slides")
  - `--theme <name>` — оформление: light, dark, glass, sunset, mint, mono (default: "light")
  - `--out <file>` — куда сохранить описание слайдов
  - `--force` — перезаписать существующий файл
- `repokit studio deck render` — отрендерить слайды в PNG, по желанию — собрать PDF
  - `--kind <kind>` — что собирать: slides, banner, wide (default: "slides")
  - `--theme <name>` — оформление: light, dark, glass, sunset, mint, mono (default: "light")
  - `--deck <file>` — описание слайдов (JSON)
  - `--out-dir <dir>` — папка для слайдов (default: "docs/slides")
  - `--width <px>` — ширина слайда (по умолчанию 1920)
  - `--pdf` — дополнительно собрать slides.pdf
- `repokit studio banner` — баннер проекта: название, тэглайн, технологии с логотипами и настоящий скриншот
  - `--kind <kind>` — что собирать: slides, banner, wide (default: "slides")
  - `--theme <name>` — оформление: light, dark, glass, sunset, mint, mono (default: "light")
  - `--deck <file>` — своё описание баннера вместо собранного из фактов
  - `--size <kind>` — banner — 1280×640, обложка репозитория; wide — 1600×520, полоса для верха README (default: "banner")
  - `--out <file>` — итоговый файл .png
  - `--width <px>` — ширина баннера (по умолчанию 1280)
- `repokit studio render` — смонтировать MP4 (и GIF/WebP): запись с авто-зумом или 3D-пресет
  - `--scene <file>` — режиссёрская сцена (JSON): свои объекты, камера, эффекты
  - `--preset <name>` — 3D-пресет; см. studio presets list
  - `--slot <id=file>` — медиа для слота пресета; можно указать несколько раз (default: [])
  - `--aspect <w:h>` — соотношение сторон вывода для пресета, например 16:9
  - `--width <px>` — ширина кадра (по умолчанию 1280)
  - `--gl <backend>` — как рисовать WebGL: angle (GPU, по умолчанию) или swangle (без GPU)
  - `--timeline <file>` — готовый timeline.json; без него таймлайн строится из записи
  - `--capture <run>` — запись capture: идентификатор или latest (default: "latest")
  - `--style <name>` — 2D-стиль: light, dark, glass (default: "light")
  - `--height <px>` — высота кадра для 2D (по умолчанию 720)
  - `--fps <n>` — частота кадров для 2D (по умолчанию 30)
  - `--no-zoom` — без авто-зума
  - `--zoom-scale <n>` — кратность зума (по умолчанию 1.8)
  - `--title <text>` — заголовок над окном
  - `--out <file>` — итоговый файл .mp4, например docs/media/hero.mp4
  - `--gif` — дополнительно создать GIF в пределах бюджета
  - `--webp` — дополнительно создать анимированный WebP
  - `--webm` — дополнительно создать WebM (VP9; со звуком, если он есть)
  - `--click-sounds` — звук щелчка на каждый клик записи
  - `--no-click-sounds` — без щелчков, даже если они включены в сцене
  - `--music <file>` — музыкальный файл из репозитория: зацикливается или обрезается по длине ролика
  - `--music-volume <n>` — громкость музыки, 0–2 (по умолчанию 0.25)
  - `--gif-budget-mb <n>` — максимальный размер GIF в мегабайтах (default: "8")
- `repokit studio still` — один кадр сцены или 3D-пресета в PNG — быстрый взгляд на результат
  - `--scene <file>` — режиссёрская сцена (JSON): свои объекты, камера, эффекты
  - `--preset <name>` — 3D-пресет; см. studio presets list
  - `--slot <id=file>` — медиа для слота пресета; можно указать несколько раз (default: [])
  - `--aspect <w:h>` — соотношение сторон вывода для пресета, например 16:9
  - `--width <px>` — ширина кадра (по умолчанию 1280)
  - `--gl <backend>` — как рисовать WebGL: angle (GPU, по умолчанию) или swangle (без GPU)
  - `--frame <n>` — номер кадра (default: "0")
  - `--at <sec>` — момент времени в секундах (вместо --frame)
  - `--out <file>` — итоговый файл .png

## brief

разбор правил хакатона: критерии, требования, матрица доказательств

- `repokit brief extract` — сохранить текст правил → .repokit/brief.source.txt и заготовку brief.json
  - `--file <path>` — файл с правилами (txt, md, html)
  - `--text <text>` — текст правил
  - `--url <url>` — страница с правилами; единственная команда сервиса, которая обращается к сети
- `repokit brief init` — создать brief.json без правил — из профиля по умолчанию
  - `--default` — использовать профиль критериев по умолчанию
  - `--force` — перезаписать существующий brief.json
- `repokit brief validate` — проверить brief.json: схема, цитаты из правил, полнота матрицы
- `repokit brief matrix` — показать матрицу «критерий → чем подтвердить»

## readme

сборка README из подтверждённых фактов

- `repokit readme presets` — список пресетов оформления
- `repokit readme human` — создать шаблон полей, которые решает человек → .repokit/readme.human.yaml
- `repokit readme plan` — собрать черновик README и показать, чем заполнен каждый раздел
  - `--preset <name>` — фиксированный шаблон вместо структуры по типу проекта; см. readme presets
  - `--style <name>` — стиль подачи: minimal, developer, product, showcase, research, docs (по умолчанию — по типу проекта)
  - `--lang <code>` — язык README: ru, en (по умолчанию ru)
  - `--hero <file>` — главное изображение или GIF, путь относительно репозитория
  - `--hero-dark <file>` — вариант главного изображения для тёмной темы
  - `--banner <file>` — баннер над названием (см. repokit studio banner --size wide)
- `repokit readme layout` — определить тип проекта и спланировать структуру README →
  - `--preset <name>` — фиксированный шаблон вместо структуры по типу проекта; см. readme presets
  - `--style <name>` — стиль подачи: minimal, developer, product, showcase, research, docs (по умолчанию — по типу проекта)
  - `--lang <code>` — язык README: ru, en (по умолчанию ru)
  - `--hero <file>` — главное изображение или GIF, путь относительно репозитория
  - `--hero-dark <file>` — вариант главного изображения для тёмной темы
  - `--banner <file>` — баннер над названием (см. repokit studio banner --size wide)
- `repokit readme generate` — то же, что plan: собрать черновик README
  - `--preset <name>` — фиксированный шаблон вместо структуры по типу проекта; см. readme presets
  - `--style <name>` — стиль подачи: minimal, developer, product, showcase, research, docs (по умолчанию — по типу проекта)
  - `--lang <code>` — язык README: ru, en (по умолчанию ru)
  - `--hero <file>` — главное изображение или GIF, путь относительно репозитория
  - `--hero-dark <file>` — вариант главного изображения для тёмной темы
  - `--banner <file>` — баннер над названием (см. repokit studio banner --size wide)
- `repokit readme audit` — оценить README по категориям: понятность, первый экран, визуалы, запуск,
  - `--draft` — проверить черновик .repokit/readme.draft.md вместо README.md
  - `--fix` — исправить механические проблемы: уровни заголовков, лишние пустые строки, очень длинные блоки кода
- `repokit readme hero-check` — проверить первый экран README: что это, для кого, что делать дальше
  - `--draft` — проверить черновик .repokit/readme.draft.md вместо README.md
- `repokit readme apply` — записать README.md; --dry-run показывает diff
  - `--preset <name>` — фиксированный шаблон вместо структуры по типу проекта; см. readme presets
  - `--style <name>` — стиль подачи: minimal, developer, product, showcase, research, docs (по умолчанию — по типу проекта)
  - `--lang <code>` — язык README: ru, en (по умолчанию ru)
  - `--hero <file>` — главное изображение или GIF, путь относительно репозитория
  - `--hero-dark <file>` — вариант главного изображения для тёмной темы
  - `--banner <file>` — баннер над названием (см. repokit studio banner --size wide)
  - `--regenerate` — заменить существующий содержательный README, написанный не repokit
- `repokit readme check` — проверить README.md: незаполненные места, битые ссылки, alt-тексты
- `repokit readme verify-quickstart` — выполнить команды запуска из README во временной копии репозитория
  - `--source <kind>` — head или worktree (default: "worktree")

## examples

реальные примеры использования из репозитория

- `repokit examples extract` — найти примеры в examples/, документации и тестах → .repokit/examples.json

## diagram

схемы, построенные по коду

- `repokit diagram architecture` — схема архитектуры в Mermaid, не больше 8 блоков → .repokit/architecture.mmd
  - `--max-blocks <n>` — сколько блоков оставить: от 3 до 12

## assets

медиафайлы документации: проверка ссылок, сжатие, уборка, имена

- `repokit assets check` — битые ссылки, тяжёлые и неиспользуемые файлы, неаккуратные имена
- `repokit assets optimize` — уменьшить слишком широкие и тяжёлые изображения и GIF; оригиналы — в
  - `--max-width <px>` — наибольшая ширина изображения (по умолчанию 1600)
- `repokit assets prune` — убрать медиафайлы, на которые никто не ссылается, в .repokit/assets-pruned/
- `repokit assets normalize` — привести имена файлов к виду kebab-case и обновить ссылки в документах
- `repokit assets convert` — преобразовать файл: --to png | jpg | webp | gif | mp4 | webm
  - `--to <format>` — целевой формат

## preview

предпросмотр README как на GitHub: в браузере для человека, снимками и JSON для

- `repokit preview serve` — локальный веб-интерфейс предпросмотра (только 127.0.0.1)
  - `--port <n>` — порт; 0 — любой свободный (default: "4173")
  - `--open` — открыть страницу в браузере по умолчанию
- `repokit preview shot` — снимки README в PNG: темы и ширины
  - `--source <kind>` — что показывать: draft (черновик по плану) или current (текущий README.md) (default: "draft")
  - `--preset <name>` — пресет README вместо сохранённого
  - `--themes <list>` — light, dark (default: "light,dark")
  - `--widths <list>` — 1280 (десктоп), 390 (телефон) (default: "1280,390")
  - `--sections` — дополнительно — по снимку на каждый раздел
  - `--out <dir>` — папка для снимков (по умолчанию .repokit/preview)
- `repokit preview check` — измеримые проблемы вида: первый экран, битые картинки, alt, переполнение, пустые
  - `--source <kind>` — что показывать: draft (черновик по плану) или current (текущий README.md) (default: "draft")
  - `--preset <name>` — пресет README вместо сохранённого

## verify

проверка репозитория глазами того, кто его только что склонировал

- `repokit verify run` — клонировать во временную папку и проверить README, ссылки, медиа, секреты,
  - `--source <kind>` — что проверять: head (чистый клон последнего коммита) или worktree (рабочая папка без игнорируемых файлов) (default: "head")
  - `--online` — проверить внешние ссылки README и адрес работающей версии
  - `--exec` — выполнить команды Quick start из README во временной копии
  - `--url <url>` — адрес работающей версии (по умолчанию — поле demoUrl)
- `repokit verify quickstart` — выполнить команды запуска из README во временной копии репозитория
  - `--source <kind>` — head (чистый клон последнего коммита) или worktree (рабочая папка без игнорируемых файлов) (default: "worktree")

## deploy

деплой на бесплатные площадки: выбор, конфигурация, запуск через ваш CLI,

- `repokit deploy providers` — список площадок и ограничения их бесплатных тарифов
- `repokit deploy detect` — какая площадка подходит проекту и почему
- `repokit deploy plan` — что будет создано, какие команды выполнятся, что останется сделать вам
  - `--provider <id>` — площадка: github-pages, cloudflare-pages, netlify, vercel, render, fly, hf-spaces, streamlit-cloud
- `repokit deploy apply` — записать файлы конфигурации в репозиторий; --dry-run показывает их содержимое
  - `--provider <id>` — площадка: github-pages, cloudflare-pages, netlify, vercel, render, fly, hf-spaces, streamlit-cloud
  - `--force` — перезаписать существующие файлы с другим содержимым
- `repokit deploy run` — запустить деплой через ваш CLI — только с --confirm
  - `--provider <id>` — площадка: github-pages, cloudflare-pages, netlify, vercel, render, fly, hf-spaces, streamlit-cloud
  - `--confirm` — подтверждаю публикацию проекта
- `repokit deploy check` — дождаться ответа сайта и запомнить адрес
  - `--provider <id>` — площадка: github-pages, cloudflare-pages, netlify, vercel, render, fly, hf-spaces, streamlit-cloud
  - `--url <url>` — адрес сайта (по умолчанию — сохранённый)
  - `--path <path>` — путь для проверки, например /health
  - `--timeout <sec>` — сколько ждать холодного старта (default: "90")

## release

релиз на GitHub: описание из фактов о проекте, создание через ваш gh

- `repokit release plan` — собрать описание релиза → .repokit/release.md
  - `--tag <tag>` — тег релиза, например v1.0.0 (по умолчанию — версия из манифеста проекта)
- `repokit release create` — создать релиз, если его ещё нет — только с --confirm
  - `--tag <tag>` — тег релиза, например v1.0.0 (по умолчанию — версия из манифеста проекта)
  - `--confirm` — подтверждаю публикацию релиза
  - `--draft` — создать черновик, не публикуя

## run

- `repokit run [options] [path]` — все шаги по порядку с остановками на одобрение: scan → brief → claims → deploy →
  - `--approve <step>` — одобрить шаг, который ждёт решения: demo, readme; можно несколько раз (default: [])
  - `--skip <step>` — пропустить шаг; можно несколько раз (default: [])
  - `--scenario <file>` — сценарий демо (по умолчанию demo.scenario.yaml в репозитории)
  - `--rules <file>` — файл с правилами хакатона
  - `--default-brief` — правил нет — взять типовой набор критериев
  - `--preset <name>` — пресет README: auto — структура по типу проекта (default: "auto")
  - `--device <name>` — устройство для 3D-версии демо: browser, laptop, phone, screen (default: "browser")
  - `--exec` — при проверке выполнить команды Quick start из README
  - `--online` — при проверке обратиться к внешним ссылкам
  - `--reset` — забыть выполненные шаги и начать заново

## doctor

- `repokit doctor [options]` — проверить внешние инструменты (ничего не устанавливает)

## setup

- `repokit setup [options]` — разовая установка медиа-сервисов (capture, studio, preview) в ~/.repokit — нужна
  - `--source <url>` — откуда брать исходники (по умолчанию — репозиторий repokit на GitHub)
  - `--force` — переустановить с нуля
