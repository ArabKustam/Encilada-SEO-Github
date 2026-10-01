// Demo data: these tide times are bundled with the page, not fetched from a tide service.
const TIDES = [
  { time: "04:12", meters: 0.4, type: "low" },
  { time: "10:31", meters: 3.1, type: "high" },
  { time: "16:40", meters: 0.6, type: "low" },
  { time: "22:55", meters: 2.9, type: "high" },
];

const METERS_TO_FEET = 3.28084;
let useFeet = false;

function render() {
  const body = document.querySelector("#tides tbody");
  body.innerHTML = "";
  for (const tide of TIDES) {
    const height = useFeet ? `${(tide.meters * METERS_TO_FEET).toFixed(1)} ft` : `${tide.meters.toFixed(1)} m`;
    const row = document.createElement("tr");
    row.innerHTML = `<td>${tide.time}</td><td>${height}</td><td>${tide.type}</td>`;
    body.appendChild(row);
  }
}

document.querySelector("#toggle-units").addEventListener("click", (event) => {
  useFeet = !useFeet;
  event.target.textContent = useFeet ? "Show meters" : "Show feet";
  render();
});

render();
