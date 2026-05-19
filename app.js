const data = window.TRACK_DATA;
const tracks = data.tracks;
const controlsByTrack = data.controlsByTrack;

const els = {
  canvas: document.querySelector("#lineCanvas"),
  lat: document.querySelector("#latValue"),
  lon: document.querySelector("#lonValue"),
  accuracy: document.querySelector("#accuracyValue"),
  time: document.querySelector("#timeValue"),
  mileage: document.querySelector("#mileageValue"),
  track: document.querySelector("#trackValue"),
  side: document.querySelector("#sideValue"),
  offset: document.querySelector("#offsetValue"),
  projection: document.querySelector("#projectionValue"),
  segment: document.querySelector("#segmentValue"),
  startGps: document.querySelector("#startGpsBtn"),
  stopGps: document.querySelector("#stopGpsBtn"),
  form: document.querySelector("#manualForm"),
  manualLat: document.querySelector("#manualLat"),
  manualLon: document.querySelector("#manualLon"),
  targetName: document.querySelector("#targetName"),
  targetMileage: document.querySelector("#targetMileage"),
  targetSide: document.querySelector("#targetSide"),
  setTarget: document.querySelector("#setTargetBtn"),
  targetSummary: document.querySelector("#targetSummary"),
  targetDelta: document.querySelector("#targetDelta"),
  targetMove: document.querySelector("#targetMove"),
  targetSideHint: document.querySelector("#targetSideHint"),
  sampleTrack: document.querySelector("#sampleTrack"),
  pointType: document.querySelector("#pointType"),
  knownMileage: document.querySelector("#knownMileage"),
  sampleNote: document.querySelector("#sampleNote"),
  saveSample: document.querySelector("#saveSampleBtn"),
  exportCsv: document.querySelector("#exportCsvBtn"),
  exportJson: document.querySelector("#exportJsonBtn"),
  clearSamples: document.querySelector("#clearSamplesBtn"),
  sampleCount: document.querySelector("#sampleCount"),
  samplesBody: document.querySelector("#samplesBody"),
};

let gpsWatchId = null;
let currentResult = null;
let currentTarget = {
  name: "Gate",
  mileageKm: 727.3,
  side: "up",
};
let samples = loadSamples();

const allPoints = Object.values(tracks).flatMap((track) => track.points);
const projectionOrigin = {
  lat: allPoints.reduce((sum, point) => sum + point.lat, 0) / allPoints.length,
  lon: allPoints.reduce((sum, point) => sum + point.lon, 0) / allPoints.length,
};

function toXY(lat, lon) {
  return {
    x: (lon - projectionOrigin.lon) * 111412.84 * Math.cos((projectionOrigin.lat * Math.PI) / 180),
    y: (lat - projectionOrigin.lat) * 111132.92,
  };
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function formatMileage(km) {
  if (!Number.isFinite(km)) return "--";
  const k = Math.floor(km);
  const m = (km - k) * 1000;
  return `K${k}+${m.toFixed(1).padStart(5, "0")}`;
}

function formatDistance(meters) {
  if (!Number.isFinite(meters)) return "--";
  return `${Math.abs(meters).toFixed(2)} m`;
}

function findCalibrationSegment(trackName, alongM) {
  const controls = controlsByTrack[trackName] || [];
  if (controls.length < 2) return null;

  for (let i = 0; i < controls.length - 1; i += 1) {
    const a = controls[i];
    const b = controls[i + 1];
    if (alongM >= a.distanceAlongM && alongM <= b.distanceAlongM) return { a, b };
  }

  if (alongM < controls[0].distanceAlongM) return { a: controls[0], b: controls[1], extrapolated: true };
  return { a: controls[controls.length - 2], b: controls[controls.length - 1], extrapolated: true };
}

function mileageAt(trackName, alongM) {
  const segment = findCalibrationSegment(trackName, alongM);
  if (!segment) return null;
  const { a, b } = segment;
  const ratio = (alongM - a.distanceAlongM) / (b.distanceAlongM - a.distanceAlongM);
  return {
    mileageKm: lerp(a.mileageKm, b.mileageKm, ratio),
    segment,
  };
}

function projectToTrack(trackName, lat, lon) {
  const track = tracks[trackName];
  const p = toXY(lat, lon);
  let best = null;

  for (let i = 0; i < track.points.length - 1; i += 1) {
    const pointA = track.points[i];
    const pointB = track.points[i + 1];
    const a = toXY(pointA.lat, pointA.lon);
    const b = toXY(pointB.lat, pointB.lon);
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const wx = p.x - a.x;
    const wy = p.y - a.y;
    const len2 = vx * vx + vy * vy;
    if (len2 === 0) continue;

    const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2));
    const proj = { x: a.x + vx * t, y: a.y + vy * t };
    const distanceM = Math.hypot(p.x - proj.x, p.y - proj.y);
    const rawCross = vx * wy - vy * wx;
    const signedOffsetM = rawCross * track.beijingDirectionSign >= 0 ? distanceM : -distanceM;
    const alongM = lerp(track.distanceAlongM[i], track.distanceAlongM[i + 1], t);

    if (!best || distanceM < best.distanceM) {
      best = {
        trackName,
        index: i,
        t,
        distanceM,
        signedOffsetM,
        alongM,
        projection: {
          lat: lerp(pointA.lat, pointB.lat, t),
          lon: lerp(pointA.lon, pointB.lon, t),
        },
      };
    }
  }

  return best;
}

function calculate(lat, lon, accuracy = null, timestamp = Date.now()) {
  const candidates = Object.keys(tracks).map((trackName) => projectToTrack(trackName, lat, lon));
  const projection = candidates.reduce((best, item) => (!best || item.distanceM < best.distanceM ? item : best), null);
  const mileage = mileageAt(projection.trackName, projection.alongM);
  const side =
    Math.abs(projection.signedOffsetM) < 0.5
      ? "On line"
      : projection.signedOffsetM > 0
        ? "Up side"
        : "Down side";

  return { lat, lon, accuracy, timestamp, projection, mileage, side };
}

function updateReadout(result) {
  currentResult = result;
  els.lat.textContent = result.lat.toFixed(8);
  els.lon.textContent = result.lon.toFixed(8);
  els.accuracy.textContent = result.accuracy == null ? "--" : `${result.accuracy.toFixed(1)} m`;
  els.time.textContent = new Date(result.timestamp).toLocaleTimeString();
  els.mileage.textContent = result.mileage ? formatMileage(result.mileage.mileageKm) : "--";
  els.track.textContent = tracks[result.projection.trackName].label;
  els.side.textContent = result.side;
  els.side.className =
    result.side === "Up side" ? "side-up" : result.side === "Down side" ? "side-down" : "";
  els.offset.textContent = `${result.projection.signedOffsetM >= 0 ? "+" : "-"}${formatDistance(
    result.projection.signedOffsetM,
  )}`;
  els.projection.textContent = `${result.projection.projection.lat.toFixed(8)}, ${result.projection.projection.lon.toFixed(8)}`;

  if (result.mileage) {
    const extrapolated = result.mileage.segment.extrapolated ? " (extrapolated)" : "";
    els.segment.textContent = `${result.mileage.segment.a.name} to ${result.mileage.segment.b.name}${extrapolated}`;
  } else {
    els.segment.textContent = "--";
  }

  draw();
  updateTargetGuidance();
}

function setTarget() {
  const mileageKm = Number.parseFloat(els.targetMileage.value);
  currentTarget = {
    name: els.targetName.value.trim() || "Target",
    mileageKm: Number.isFinite(mileageKm) ? mileageKm : null,
    side: els.targetSide.value,
  };
  updateTargetGuidance();
}

function updateTargetGuidance() {
  if (!currentTarget || !Number.isFinite(currentTarget.mileageKm)) {
    els.targetSummary.textContent = "--";
    els.targetDelta.textContent = "--";
    els.targetMove.textContent = "--";
    els.targetSideHint.textContent = "--";
    return;
  }

  els.targetSummary.textContent = `${currentTarget.name} ${formatMileage(currentTarget.mileageKm)} ${formatTargetSide(
    currentTarget.side,
  )}`;

  if (!currentResult?.mileage?.mileageKm) {
    els.targetDelta.textContent = "--";
    els.targetMove.textContent = "--";
    els.targetSideHint.textContent = "--";
    return;
  }

  const deltaM = (currentTarget.mileageKm - currentResult.mileage.mileageKm) * 1000;
  els.targetDelta.textContent = `${deltaM >= 0 ? "+" : "-"}${Math.abs(deltaM).toFixed(1)} m`;
  if (Math.abs(deltaM) < 3) {
    els.targetMove.textContent = "At target mileage";
  } else {
    els.targetMove.textContent = deltaM > 0 ? "Move toward increasing mileage" : "Move toward decreasing mileage";
  }

  els.targetSideHint.textContent = sideHint(currentResult.side, currentTarget.side);
}

function formatTargetSide(side) {
  if (side === "up") return "Up side";
  if (side === "down") return "Down side";
  return "Any side";
}

function sideHint(currentSide, targetSide) {
  if (targetSide === "any") return "Target side is not specified";
  const wanted = targetSide === "up" ? "Up side" : "Down side";
  if (currentSide === "On line") return `Approach ${wanted}`;
  if (currentSide === wanted) return `Already on ${wanted}`;
  return `Move/cross toward ${wanted}`;
}

function sampleFromResult(result) {
  const knownMileage = Number.parseFloat(els.knownMileage.value);
  return {
    id: `S${Date.now()}`,
    savedAt: new Date().toISOString(),
    trackInput: els.sampleTrack.value,
    pointType: els.pointType.value,
    knownMileageKm: Number.isFinite(knownMileage) ? knownMileage : null,
    note: els.sampleNote.value.trim(),
    gps: {
      lat: result.lat,
      lon: result.lon,
      accuracyM: result.accuracy,
      timestamp: new Date(result.timestamp).toISOString(),
    },
    calculated: {
      mileageKm: result.mileage?.mileageKm ?? null,
      mileageText: result.mileage ? formatMileage(result.mileage.mileageKm) : "",
      nearestTrack: result.projection.trackName,
      nearestTrackLabel: tracks[result.projection.trackName].label,
      lineSide: result.side,
      signedOffsetM: result.projection.signedOffsetM,
      offsetDistanceM: result.projection.distanceM,
      projectionLat: result.projection.projection.lat,
      projectionLon: result.projection.projection.lon,
      referenceSegment: result.mileage
        ? `${result.mileage.segment.a.name} to ${result.mileage.segment.b.name}`
        : "",
    },
    model: {
      sectionMinKm: data.meta.sectionMileageKm.min,
      sectionMaxKm: data.meta.sectionMileageKm.max,
      version: "20260519d",
    },
  };
}

function loadSamples() {
  try {
    return JSON.parse(window.localStorage?.getItem("lineMileageSamples") || "[]");
  } catch {
    return [];
  }
}

function persistSamples() {
  try {
    window.localStorage?.setItem("lineMileageSamples", JSON.stringify(samples));
  } catch {
    // Some embedded browsers disable storage; the in-memory list still exports.
  }
}

function renderSamples() {
  els.sampleCount.textContent = `${samples.length} ${samples.length === 1 ? "record" : "records"}`;
  if (!samples.length) {
    els.samplesBody.innerHTML = '<tr><td colspan="12" class="empty-row">No saved samples.</td></tr>';
    return;
  }

  els.samplesBody.innerHTML = samples
    .map((sample, index) => {
      const known = sample.knownMileageKm == null ? "" : formatMileage(sample.knownMileageKm);
      const accuracy = sample.gps.accuracyM == null ? "" : `${sample.gps.accuracyM.toFixed(1)} m`;
      const offset = `${sample.calculated.signedOffsetM >= 0 ? "+" : "-"}${formatDistance(
        sample.calculated.signedOffsetM,
      )}`;
      return `<tr>
        <td>${index + 1}</td>
        <td class="mono">${new Date(sample.savedAt).toLocaleTimeString()}</td>
        <td>${escapeHtml(sample.trackInput ?? "")}</td>
        <td>${escapeHtml(sample.pointType)}</td>
        <td class="mono">${known}</td>
        <td class="mono">${escapeHtml(sample.calculated.mileageText)}</td>
        <td>${escapeHtml(sample.calculated.nearestTrackLabel)}</td>
        <td>${escapeHtml(sample.calculated.lineSide)}</td>
        <td class="mono">${offset}</td>
        <td class="mono">${accuracy}</td>
        <td class="mono">${sample.gps.lat.toFixed(8)}, ${sample.gps.lon.toFixed(8)}</td>
        <td>${escapeHtml(sample.note)}</td>
      </tr>`;
    })
    .join("");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function saveSample() {
  if (!currentResult) return;
  samples.push(sampleFromResult(currentResult));
  persistSamples();
  renderSamples();
  els.sampleNote.value = "";
}

function flattenSample(sample, index) {
  return {
    index: index + 1,
    savedAt: sample.savedAt,
    trackInput: sample.trackInput ?? "",
    pointType: sample.pointType,
    knownMileageKm: sample.knownMileageKm ?? "",
    gpsLat: sample.gps.lat,
    gpsLon: sample.gps.lon,
    gpsAccuracyM: sample.gps.accuracyM ?? "",
    gpsTimestamp: sample.gps.timestamp,
    calculatedMileageKm: sample.calculated.mileageKm ?? "",
    calculatedMileageText: sample.calculated.mileageText,
    nearestTrack: sample.calculated.nearestTrack,
    lineSide: sample.calculated.lineSide,
    signedOffsetM: sample.calculated.signedOffsetM,
    offsetDistanceM: sample.calculated.offsetDistanceM,
    projectionLat: sample.calculated.projectionLat,
    projectionLon: sample.calculated.projectionLon,
    referenceSegment: sample.calculated.referenceSegment,
    note: sample.note,
  };
}

function exportCsv() {
  const rows = samples.map(flattenSample);
  if (!rows.length) return;
  const headers = Object.keys(rows[0]);
  const csv = [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(",")),
  ].join("\r\n");
  download(`field-samples-${timestampForFile()}.csv`, csv, "text/csv;charset=utf-8");
}

function csvCell(value) {
  const text = String(value ?? "");
  if (/[",\r\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

function exportJson() {
  if (!samples.length) return;
  const payload = {
    exportedAt: new Date().toISOString(),
    app: "Line Mileage Prototype",
    section: data.meta.sectionMileageKm,
    samples,
  };
  download(`field-samples-${timestampForFile()}.json`, JSON.stringify(payload, null, 2), "application/json");
}

function download(filename, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function timestampForFile() {
  return new Date().toISOString().replaceAll(":", "").replace(/\.\d+Z$/, "Z");
}

function clearSamples() {
  if (!samples.length) return;
  if (!confirm("Clear all saved samples?")) return;
  samples = [];
  persistSamples();
  renderSamples();
}

function boundsFor(points) {
  return points.reduce(
    (acc, point) => ({
      minX: Math.min(acc.minX, point.x),
      maxX: Math.max(acc.maxX, point.x),
      minY: Math.min(acc.minY, point.y),
      maxY: Math.max(acc.maxY, point.y),
    }),
    { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity },
  );
}

function draw() {
  const canvas = els.canvas;
  const rect = canvas.getBoundingClientRect();
  const scaleFactor = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(rect.width * scaleFactor));
  canvas.height = Math.max(1, Math.floor(rect.height * scaleFactor));

  const ctx = canvas.getContext("2d");
  ctx.setTransform(scaleFactor, 0, 0, scaleFactor, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);

  const xyPoints = Object.values(tracks).flatMap((track) => track.points.map((point) => toXY(point.lat, point.lon)));
  const bounds = boundsFor(xyPoints);
  const pad = 28;
  const width = rect.width - pad * 2;
  const height = rect.height - pad * 2;
  const sx = width / (bounds.maxX - bounds.minX || 1);
  const sy = height / (bounds.maxY - bounds.minY || 1);
  const s = Math.min(sx, sy);

  function screen(point) {
    return {
      x: pad + (point.x - bounds.minX) * s + (width - (bounds.maxX - bounds.minX) * s) / 2,
      y: rect.height - pad - (point.y - bounds.minY) * s - (height - (bounds.maxY - bounds.minY) * s) / 2,
    };
  }

  Object.entries(tracks).forEach(([name, track]) => {
    ctx.lineWidth = currentResult?.projection.trackName === name ? 3 : 1.8;
    ctx.strokeStyle = name === "up" ? "#126c64" : "#6b5b95";
    ctx.beginPath();
    track.points.forEach((point, i) => {
      const p = screen(toXY(point.lat, point.lon));
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    });
    ctx.stroke();
  });

  data.controlPoints.forEach((control) => {
    if (control.mileageKm < data.meta.sectionMileageKm.min || control.mileageKm > data.meta.sectionMileageKm.max) return;
    const p = screen(toXY(control.lat, control.lon));
    ctx.fillStyle = control.track === "up" ? "#17212b" : "#4f3f78";
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = "12px Inter, system-ui, sans-serif";
    ctx.fillText(control.name, p.x + 8, p.y - 8);
  });

  if (currentResult) {
    const gps = screen(toXY(currentResult.lat, currentResult.lon));
    const proj = screen(toXY(currentResult.projection.projection.lat, currentResult.projection.projection.lon));

    ctx.strokeStyle = "#b43b45";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(gps.x, gps.y);
    ctx.lineTo(proj.x, proj.y);
    ctx.stroke();

    ctx.fillStyle = "#b43b45";
    ctx.beginPath();
    ctx.arc(gps.x, gps.y, 6, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#126c64";
    ctx.beginPath();
    ctx.arc(proj.x, proj.y, 5, 0, Math.PI * 2);
    ctx.fill();
  }
}

function startGps() {
  if (!navigator.geolocation) {
    alert("Geolocation is not supported by this browser.");
    return;
  }

  gpsWatchId = navigator.geolocation.watchPosition(
    (position) => {
      updateReadout(
        calculate(position.coords.latitude, position.coords.longitude, position.coords.accuracy, position.timestamp),
      );
    },
    (error) => {
      alert(error.message);
      stopGps();
    },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 8000 },
  );

  els.startGps.disabled = true;
  els.stopGps.disabled = false;
}

function stopGps() {
  if (gpsWatchId != null) {
    navigator.geolocation.clearWatch(gpsWatchId);
    gpsWatchId = null;
  }
  els.startGps.disabled = false;
  els.stopGps.disabled = true;
}

els.startGps.addEventListener("click", startGps);
els.stopGps.addEventListener("click", stopGps);
els.setTarget.addEventListener("click", setTarget);
els.saveSample.addEventListener("click", saveSample);
els.exportCsv.addEventListener("click", exportCsv);
els.exportJson.addEventListener("click", exportJson);
els.clearSamples.addEventListener("click", clearSamples);
els.form.addEventListener("submit", (event) => {
  event.preventDefault();
  const lat = Number.parseFloat(els.manualLat.value);
  const lon = Number.parseFloat(els.manualLon.value);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
  updateReadout(calculate(lat, lon));
});

window.addEventListener("resize", draw);
setTarget();
updateReadout(calculate(Number.parseFloat(els.manualLat.value), Number.parseFloat(els.manualLon.value)));
renderSamples();
