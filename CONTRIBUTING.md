# Как добавить 3D-пресет

Пресет — это папка `presets/3d/<имя>/` с тремя файлами:

```
presets/3d/my-device/
  preset.json    описание: слоты, камера, свет, фон
  Scene.tsx      сцена на react-three-fiber
  preview.gif    превью, собранное самим repokit
```

## 1. preset.json

Схема: [schemas/preset.schema.json](schemas/preset.schema.json). Проще всего скопировать
[presets/3d/phone-float/preset.json](presets/3d/phone-float/preset.json) и поправить.

- `name` совпадает с именем папки.
- `slots` — экраны, куда встанет медиа пользователя. У каждого: `id`, `type` (`image`, `video` или `any`),
  `mesh` (имя объекта в сцене), `fit` (`cover` обрезает края, `contain` добавляет поля), `aspect` (ширина / высота экрана).
- `aspectRatios` — поддерживаемые соотношения сторон вывода. Первое — то, под которое поставлена камера;
  для более узких кадров угол обзора расширяется автоматически, чтобы устройство не обрезалось по бокам.
- `camera.keyframes` — положения камеры по кадрам. Движение сглаживается целиком, а не по отрезкам.
- `lights`, `background` (CSS-фон за сценой).

## 2. Scene.tsx

Сцена получает описание пресета и строит устройство. Экран ставится компонентом `Screen` — он сам найдёт медиа слота,
подгонит пропорции и дождётся загрузки текстуры перед снимком кадра.

```tsx
import { RoundedSlab, Screen, SoftShadow } from "../_engine/engine.js";
import type { SceneComponent } from "../_engine/types.js";

export const Scene: SceneComponent = () => (
  <group>
    <RoundedSlab width={2} height={1.3} depth={0.08} radius={0.1}>
      <meshStandardMaterial color="#2b2d33" />
    </RoundedSlab>
    <group position={[0, 0, 0.042]}>
      <Screen slot="main" width={1.9} radius={0.05} />
    </group>
  </group>
);
```

Правила:

- **Только процедурная геометрия.** Никаких внешних моделей, текстур и логотипов; устройство не должно копировать
  конкретный продукт. Внешние `.glb` допустимы только с лицензией CC0 или CC-BY и записью в `ATTRIBUTION.md`.
- **Экран показывает медиа как есть.** Не затемняйте, не перекрашивайте и не дорисовывайте содержимое слота:
  `Screen` намеренно использует материал без освещения.
- **Анимация зависит только от номера кадра** (`useCurrentFrame()`), без таймеров и случайных чисел — иначе рендер
  перестанет быть воспроизводимым.
- Строки интерфейса на устройстве (адресная строка, заголовки) не пишите: это выглядело бы как содержимое приложения.

## 3. Регистрация

Добавьте сцену в [presets/3d/index.ts](presets/3d/index.ts) под тем же именем, что в `preset.json`.

## 4. Проверка и превью

```bash
pnpm build
```

```bash
node packages/cli/dist/bin.js studio presets list
```

Кадр для быстрой проверки (медиа должно лежать внутри репозитория, указанного в `--repo`):

```bash
node packages/cli/dist/bin.js studio still --repo examples/web-app --preset my-device --slot main=shot.png --frame 0 --out .repokit/out/check.png
```

Превью собирается из настоящей записи учебного приложения `examples/web-app`, а не из нарисованной картинки:

```bash
node packages/cli/dist/bin.js capture run --repo examples/web-app --scenario examples/web-app/demo.scenario.yaml
```

```bash
node packages/cli/dist/bin.js studio render --repo examples/web-app --preset my-device --slot main=.repokit/capture/<запись>/video.mp4 --width 640 --out .repokit/out/preview.mp4 --gif
```

Скопируйте получившийся `preview.gif` в папку пресета.

## 5. Снапшоты

Добавьте пресет в список `CASES` в [tests/e2e/presets.test.ts](tests/e2e/presets.test.ts) и создайте эталонные кадры:

```bash
REPOKIT_E2E_MEDIA=1 REPOKIT_UPDATE_SNAPSHOTS=1 pnpm test
```

Эталоны рендерятся программным GL (`swangle`), чтобы не зависеть от видеокарты. Тест допускает расхождение до 2 % пикселей.
При несовпадении фактический кадр и карта различий сохраняются в `tests/snapshots/__failed__/`.

## Общие требования к коду

- `pnpm test` проходит.
- Новая зависимость — только с совместимой лицензией (не AGPL) и строкой в `ATTRIBUTION.md`.
- Сервис ничего не скачивает и не отправляет в сеть без явного флага.
