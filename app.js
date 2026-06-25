const data = window.TRACK_DATA;
const tracks = data.tracks;

const els = {
  canvas: document.querySelector("#lineCanvas"),
  mapDetails: document.querySelector("#mapDetails"),
  gpsStatus: document.querySelector("#gpsStatus"),
  gpsStatusText: document.querySelector("#gpsStatusText"),
  gpsToggle: document.querySelector("#gpsToggleBtn"),
  gpsToggleText: document.querySelector("#gpsToggleText"),
  lat: document.querySelector("#latValue"),
  lon: document.querySelector("#lonValue"),
  accuracy: document.querySelector("#accuracyValue"),
  time: document.querySelector("#timeValue"),
  mileage: document.querySelector("#mileageValue"),
  track: document.querySelector("#trackValue"),
  side: document.querySelector("#sideValue"),
  offset: document.querySelector("#offsetValue"),
  segment: document.querySelector("#segmentValue"),
  confidence: document.querySelector("#confidenceValue"),
  manualForm: document.querySelector("#manualForm"),
  manualLat: document.querySelector("#manualLat"),
  manualLon: document.querySelector("#manualLon"),
  targetForm: document.querySelector("#targetForm"),
  targetName: document.querySelector("#targetName"),
  targetTrack: document.querySelector("#targetTrack"),
  targetMileage: document.querySelector("#targetMileage"),
  targetSide: document.querySelector("#targetSide"),
  targetSummary: document.querySelector("#targetSummary"),
  targetDelta: document.querySelector("#targetDelta"),
  targetMove: document.querySelector("#targetMove"),
  targetSideHint: document.querySelector("#targetSideHint"),
  calibrationForm: document.querySelector("#calibrationForm"),
  actualTrack: document.querySelector("#actualTrack"),
  actualMileage: document.querySelector("#actualMileage"),
  calibrationNote: document.querySelector("#calibrationNote"),
  calibrationComputed: document.querySelector("#calibrationComputed"),
  calibrationError: document.querySelector("#calibrationError"),
  exportCsv: document.querySelector("#exportCsvBtn"),
  exportJson: document.querySelector("#exportJsonBtn"),
  clearSamples: document.querySelector("#clearSamplesBtn"),
  sampleCount: document.querySelector("#sampleCount"),
  recordSummary: document.querySelector("#recordSummary"),
  samplesList: document.querySelector("#samplesList"),
  toast: document.querySelector("#toast"),
};

let gpsWatchId = null;
let currentResult = null;
let toastTimer = null;
let samples = loadSamples();
let currentTarget = {
  name: "网门",
  track: "up",
  mileageKm: 727.3,
  side: "any",
};

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
  let k = Math.floor(km);
  let meters = Math.round((km - k) * 1000 * 10) / 10;
  if (meters >= 1000) {
    k += 1;
    meters = 0;
  }
  return `K${k}+${meters.toFixed(1).padStart(5, "0")}`;
}

function parseMileageInput(value) {
  const text = String(value ?? "").trim().toUpperCase().replaceAll(" ", "");
  if (!text) return Number.NaN;
  const kPlus = text.match(/^K?(\d+)\+(\d+(?:\.\d+)?)$/);
  if (kPlus) return Number(kPlus[1]) + Number(kPlus[2]) / 1000;
  const decimal = Number(text.replace(/^K/, ""));
  return Number.isFinite(decimal) ? decimal : Number.NaN;
}

function formatDistance(meters, digits = 1) {
  if (!Number.isFinite(meters)) return "--";
  return `${Math.abs(meters).toFixed(digits)} 米`;
}

function trackName(trackNameValue) {
  return trackNameValue === "up" ? "上行" : "下行";
}

function sideName(side) {
  if (side === "On line") return "线路中心附近";
  return side === "Up side" ? "上行侧" : "下行侧";
}

function sourceLabel(source) {
  if (String(source).includes("2026-06-24")) return "6月24日有效段";
  if (String(source).includes("2026-06-02")) return "6月2日补齐段";
  return source || "参考轨迹";
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => els.toast.classList.remove("is-visible"), 2600);
}

function setGpsUi(mode, text) {
  els.gpsStatus.dataset.state = mode;
  els.gpsStatusText.textContent = text;
  const isRunning = mode === "running";
  els.gpsToggle.classList.toggle("is-running", isRunning);
  els.gpsToggleText.textContent = isRunning ? "停止定位" : "开始定位";
  els.gpsToggle.querySelector(".button-icon").textContent = isRunning ? "■" : "◎";
}

function findTrackDataSegment(track, alongM) {
  const distances = track.distanceAlongM || [];
  if (distances.length < 2) return null;
  if (alongM <= distances[0]) return { index: 0, t: 0, extrapolated: alongM < distances[0] };
  const lastIndex = distances.length - 1;
  if (alongM >= distances[lastIndex]) return { index: lastIndex - 1, t: 1, extrapolated: alongM > distances[lastIndex] };

  let low = 0;
  let high = lastIndex;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (distances[middle] <= alongM) low = middle;
    else high = middle;
  }
  const span = distances[low + 1] - distances[low];
  return { index: low, t: span <= 0 ? 0 : (alongM - distances[low]) / span, extrapolated: false };
}

function mileageAt(trackNameValue, alongM) {
  const track = tracks[trackNameValue];
  const dataSegment = findTrackDataSegment(track, alongM);
  if (!dataSegment || !Array.isArray(track.mileageKm)) return null;

  const { index, t, extrapolated } = dataSegment;
  const aMileage = track.mileageKm[index];
  const bMileage = track.mileageKm[index + 1];
  if (!Number.isFinite(aMileage) || !Number.isFinite(bMileage)) return null;
  const sourceA = track.pointSources?.[index] || "参考轨迹";
  const sourceB = track.pointSources?.[index + 1] || sourceA;

  return {
    mileageKm: lerp(aMileage, bMileage, t),
    segment: {
      a: { name: sourceA },
      b: { name: sourceB },
      extrapolated,
      seam: Boolean(track.pointIsSeam?.[index] || track.pointIsSeam?.[index + 1]),
    },
  };
}

function projectToTrack(trackNameValue, lat, lon) {
  const track = tracks[trackNameValue];
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
        trackName: trackNameValue,
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

function buildResult(projection, lat, lon, accuracy = null, timestamp = Date.now(), source = "gps") {
  if (!projection) return null;
  const mileage = mileageAt(projection.trackName, projection.alongM);
  const side = Math.abs(projection.signedOffsetM) < 0.5 ? "On line" : projection.signedOffsetM > 0 ? "Up side" : "Down side";
  return { lat, lon, accuracy, timestamp, source, projection, mileage, side };
}

function calculate(lat, lon, accuracy = null, timestamp = Date.now(), source = "gps") {
  const candidates = Object.keys(tracks).map((trackNameValue) => projectToTrack(trackNameValue, lat, lon));
  const projection = candidates.reduce((best, item) => (!best || item.distanceM < best.distanceM ? item : best), null);
  return buildResult(projection, lat, lon, accuracy, timestamp, source);
}

function calculateOnTrack(trackNameValue, lat, lon, accuracy = null, timestamp = Date.now(), source = "gps") {
  return buildResult(projectToTrack(trackNameValue, lat, lon), lat, lon, accuracy, timestamp, source);
}

function confidenceText(result) {
  const offset = result.projection.distanceM;
  const accuracy = result.accuracy;
  if (Number.isFinite(accuracy) && accuracy <= 10 && offset <= 15) return "匹配较好：仍建议用已知点现场核验";
  if (Number.isFinite(accuracy) && accuracy <= 25 && offset <= 35) return "匹配一般：请结合现场线路判断";
  if (Number.isFinite(accuracy) && accuracy > 25) return "GPS 精度较低：建议到开阔位置再核验";
  if (offset > 35) return "离参考轨迹较远：请优先核对现场位置";
  return "请结合现场已知里程进行校验";
}

function updateReadout(result) {
  currentResult = result;
  els.lat.textContent = result.lat.toFixed(8);
  els.lon.textContent = result.lon.toFixed(8);
  els.accuracy.textContent = result.accuracy == null ? "--" : `±${formatDistance(result.accuracy)}`;
  els.time.textContent = new Date(result.timestamp).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  els.mileage.textContent = result.mileage ? formatMileage(result.mileage.mileageKm) : "--";
  els.track.textContent = tracks[result.projection.trackName].label;
  els.side.textContent = sideName(result.side);
  els.side.className = "side-chip";
  els.side.classList.add(result.side === "Up side" ? "side-up" : result.side === "Down side" ? "side-down" : "side-line");
  els.offset.textContent = `${result.projection.signedOffsetM >= 0 ? "+" : "−"}${formatDistance(result.projection.signedOffsetM)}`;
  els.confidence.textContent = confidenceText(result);

  if (result.mileage) {
    const { a, b, extrapolated, seam } = result.mileage.segment;
    const aLabel = sourceLabel(a.name);
    const bLabel = sourceLabel(b.name);
    const sources = aLabel === bLabel ? aLabel : `${aLabel} → ${bLabel}`;
    const flags = `${seam ? " · 拼接处" : ""}${extrapolated ? " · 外推" : ""}`;
    els.segment.textContent = `${sources}${flags}`;
  } else {
    els.segment.textContent = "--";
  }

  if (result.source === "manual" && gpsWatchId == null) setGpsUi("manual", "手动坐标测试");
  updateCalibrationPreview();
  updateTargetGuidance();
  if (els.mapDetails.open) draw();
}

function selectedCalibrationResult() {
  if (!currentResult) return null;
  const forcedTrack = els.actualTrack.value;
  if (forcedTrack === "auto") return currentResult;
  return calculateOnTrack(forcedTrack, currentResult.lat, currentResult.lon, currentResult.accuracy, currentResult.timestamp, currentResult.source);
}

function formatError(errorM) {
  if (!Number.isFinite(errorM)) return "--";
  if (Math.abs(errorM) < 0.5) return "误差不足 0.5 米";
  return errorM > 0 ? `软件偏大 ${Math.abs(errorM).toFixed(1)} 米` : `软件偏小 ${Math.abs(errorM).toFixed(1)} 米`;
}

function updateCalibrationPreview() {
  const result = selectedCalibrationResult();
  const actualMileage = parseMileageInput(els.actualMileage.value);
  els.calibrationError.className = "";

  if (!result?.mileage) {
    els.calibrationComputed.textContent = "等待定位";
    els.calibrationError.textContent = "填写实际里程后计算";
    return;
  }

  els.calibrationComputed.textContent = `${tracks[result.projection.trackName].label} ${formatMileage(result.mileage.mileageKm)}`;
  if (!Number.isFinite(actualMileage)) {
    els.calibrationError.textContent = "填写实际里程后计算";
    return;
  }

  const errorM = (result.mileage.mileageKm - actualMileage) * 1000;
  els.calibrationError.textContent = formatError(errorM);
  els.calibrationError.classList.add(Math.abs(errorM) <= 20 ? "error-good" : "error-large");
}

function buildSample(result, { trackInput = "auto", knownMileageKm = null, note = "", pointType = "check" } = {}) {
  const calculatedMileage = result.mileage?.mileageKm ?? null;
  const errorM = Number.isFinite(calculatedMileage) && Number.isFinite(knownMileageKm) ? (calculatedMileage - knownMileageKm) * 1000 : null;
  return {
    id: `S${Date.now()}`,
    savedAt: new Date().toISOString(),
    trackInput,
    pointType,
    knownMileageKm: Number.isFinite(knownMileageKm) ? knownMileageKm : null,
    note,
    gps: {
      lat: result.lat,
      lon: result.lon,
      accuracyM: result.accuracy,
      timestamp: new Date(result.timestamp).toISOString(),
    },
    calculated: {
      mileageKm: calculatedMileage,
      mileageText: result.mileage ? formatMileage(calculatedMileage) : "",
      nearestTrack: result.projection.trackName,
      nearestTrackLabel: tracks[result.projection.trackName].label,
      lineSide: sideName(result.side),
      signedOffsetM: result.projection.signedOffsetM,
      offsetDistanceM: result.projection.distanceM,
      projectionLat: result.projection.projection.lat,
      projectionLon: result.projection.projection.lon,
      mileageErrorM: errorM,
      referenceSegment: result.mileage ? `${sourceLabel(result.mileage.segment.a.name)} → ${sourceLabel(result.mileage.segment.b.name)}` : "",
    },
    model: {
      sectionMinKm: data.meta.sectionMileageKm.min,
      sectionMaxKm: data.meta.sectionMileageKm.max,
      version: data.meta.version || "20260625-minimal1",
    },
  };
}

function saveCalibration(event) {
  event.preventDefault();
  if (!currentResult) {
    showToast("请先开始定位，或用手动坐标测试后再保存");
    return;
  }

  const knownMileageKm = parseMileageInput(els.actualMileage.value);
  if (!Number.isFinite(knownMileageKm)) {
    showToast("请填写实际里程，例如 769.703 或 K769+703");
    els.actualMileage.focus();
    return;
  }

  const result = selectedCalibrationResult();
  const sample = buildSample(result, {
    trackInput: els.actualTrack.value,
    knownMileageKm,
    note: els.calibrationNote.value.trim(),
    pointType: "check",
  });
  samples.push(sample);
  persistSamples();
  renderSamples();
  els.actualMileage.value = "";
  els.calibrationNote.value = "";
  updateCalibrationPreview();
  showToast(`校验点已保存：${formatError(sample.calculated.mileageErrorM)}`);
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

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatTrackInput(track) {
  return { auto: "自动判断", up: "上行", down: "下行", unknown: "未知" }[track] || track || "--";
}

function renderSamples() {
  const countText = `${samples.length} 条`;
  els.sampleCount.textContent = countText;
  els.recordSummary.textContent = countText;
  if (!samples.length) {
    els.samplesList.innerHTML = '<p class="empty-records">暂无校验记录。</p>';
    return;
  }

  els.samplesList.innerHTML = samples
    .slice()
    .reverse()
    .map((sample) => {
      const savedTime = new Date(sample.savedAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
      const actual = sample.knownMileageKm == null ? "未填写" : formatMileage(sample.knownMileageKm);
      const calculated = sample.calculated?.mileageText || "未计算里程";
      const accuracy = sample.gps?.accuracyM == null ? "--" : `±${formatDistance(sample.gps.accuracyM)}`;
      const offset = Number.isFinite(sample.calculated?.signedOffsetM) ? `${sample.calculated.signedOffsetM >= 0 ? "+" : "−"}${formatDistance(sample.calculated.signedOffsetM)}` : "--";
      const error = formatError(sample.calculated?.mileageErrorM);
      return `<article class="sample-card">
        <div class="sample-card-header">
          <h3>${escapeHtml(actual)} · ${escapeHtml(error)}</h3>
          <time>${savedTime}</time>
        </div>
        <div class="sample-card-grid">
          <div><span>软件计算</span><strong>${escapeHtml(calculated)}</strong></div>
          <div><span>校验行别</span><strong>${escapeHtml(formatTrackInput(sample.trackInput))}</strong></div>
          <div><span>最近轨迹</span><strong>${escapeHtml(sample.calculated?.nearestTrackLabel || "--")}</strong></div>
          <div><span>侧别 / 偏移</span><strong>${escapeHtml(sample.calculated?.lineSide || "--")} · ${escapeHtml(offset)}</strong></div>
          <div><span>GPS 精度</span><strong>${escapeHtml(accuracy)}</strong></div>
          <div><span>参考分段</span><strong>${escapeHtml(sample.calculated?.referenceSegment || "--")}</strong></div>
        </div>
        ${sample.note ? `<p class="sample-note">${escapeHtml(sample.note)}</p>` : ""}
      </article>`;
    })
    .join("");
}

function flattenSample(sample, index) {
  return {
    序号: index + 1,
    保存时间: sample.savedAt,
    校验行别: formatTrackInput(sample.trackInput),
    点位类型: sample.pointType || "核验点",
    实际里程_km: sample.knownMileageKm ?? "",
    实际里程: sample.knownMileageKm == null ? "" : formatMileage(sample.knownMileageKm),
    GPS纬度: sample.gps?.lat ?? "",
    GPS经度: sample.gps?.lon ?? "",
    GPS精度_米: sample.gps?.accuracyM ?? "",
    GPS时间: sample.gps?.timestamp ?? "",
    软件里程_km: sample.calculated?.mileageKm ?? "",
    软件里程: sample.calculated?.mileageText ?? "",
    软件误差_米: sample.calculated?.mileageErrorM ?? "",
    最近轨迹: sample.calculated?.nearestTrackLabel ?? "",
    线路侧别: sample.calculated?.lineSide ?? "",
    有符号偏移_米: sample.calculated?.signedOffsetM ?? "",
    距参考轨迹_米: sample.calculated?.offsetDistanceM ?? "",
    投影纬度: sample.calculated?.projectionLat ?? "",
    投影经度: sample.calculated?.projectionLon ?? "",
    参考分段: sample.calculated?.referenceSegment ?? "",
    备注: sample.note ?? "",
  };
}

function exportCsv() {
  const rows = samples.map(flattenSample);
  if (!rows.length) {
    showToast("暂无校验记录可导出");
    return;
  }
  const headers = Object.keys(rows[0]);
  const csv = [headers.join(","), ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(","))].join("\r\n");
  download(`铁路里程校验_${timestampForFile()}.csv`, `\uFEFF${csv}`, "text/csv;charset=utf-8");
  showToast("CSV 已导出");
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function exportJson() {
  if (!samples.length) {
    showToast("暂无校验记录可导出");
    return;
  }
  const payload = {
    exportedAt: new Date().toISOString(),
    app: data.meta.name || "铁路里程定位测试",
    section: data.meta.sectionMileageKm,
    samples,
  };
  download(`铁路里程校验_${timestampForFile()}.json`, JSON.stringify(payload, null, 2), "application/json");
  showToast("JSON 已导出");
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
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function timestampForFile() {
  return new Date().toISOString().replaceAll(":", "").replace(/\.\d+Z$/, "Z");
}

function clearSamples() {
  if (!samples.length) {
    showToast("当前没有校验记录");
    return;
  }
  if (!confirm("确认清空本机保存的全部校验记录吗？此操作不能撤销。")) return;
  samples = [];
  persistSamples();
  renderSamples();
  showToast("校验记录已清空");
}

function setTarget(event) {
  event?.preventDefault();
  const mileageKm = parseMileageInput(els.targetMileage.value);
  if (!Number.isFinite(mileageKm)) {
    showToast("请填写正确的目标里程，例如 727.300");
    return;
  }
  currentTarget = {
    name: els.targetName.value.trim() || "目标点",
    track: els.targetTrack.value,
    mileageKm,
    side: els.targetSide.value,
  };
  updateTargetGuidance();
  if (event) showToast("目标已保存");
}

function updateTargetGuidance() {
  if (!currentTarget || !Number.isFinite(currentTarget.mileageKm)) return;
  const targetTrackText = trackName(currentTarget.track);
  const targetSideText = formatTargetSide(currentTarget.side);
  els.targetSummary.textContent = `${targetTrackText} ${formatMileage(currentTarget.mileageKm)} · ${currentTarget.name}${targetSideText === "不限侧别" ? "" : ` · ${targetSideText}`}`;
  if (!currentResult?.mileage?.mileageKm) {
    els.targetDelta.textContent = "等待定位";
    els.targetMove.textContent = "开始定位后计算";
    els.targetSideHint.textContent = "--";
    return;
  }
  const deltaM = (currentTarget.mileageKm - currentResult.mileage.mileageKm) * 1000;
  els.targetDelta.textContent = `${deltaM >= 0 ? "+" : "−"}${Math.abs(deltaM).toFixed(1)} 米`;
  els.targetMove.textContent = Math.abs(deltaM) < 3 ? "已到达目标里程附近" : deltaM > 0 ? "往里程增加方向" : "往里程减小方向";
  const trackHint = currentResult.projection.trackName === currentTarget.track ? "同一参考轨迹" : `当前贴近${trackName(currentResult.projection.trackName)}，目标在${targetTrackText}`;
  els.targetSideHint.textContent = `${trackHint}；${sideHint(currentResult.side, currentTarget.side)}`;
}

function formatTargetSide(side) {
  if (side === "up") return "上行侧";
  if (side === "down") return "下行侧";
  return "不限侧别";
}

function sideHint(currentSide, targetSide) {
  if (targetSide === "any") return "目标未限定侧别";
  const wanted = targetSide === "up" ? "上行侧" : "下行侧";
  if (currentSide === "On line") return `到达里程后注意确认${wanted}`;
  if (sideName(currentSide) === wanted) return `当前已在${wanted}`;
  return `到达里程后需向${wanted}确认`;
}

function boundsFor(points) {
  return points.reduce((acc, point) => ({ minX: Math.min(acc.minX, point.x), maxX: Math.max(acc.maxX, point.x), minY: Math.min(acc.minY, point.y), maxY: Math.max(acc.maxY, point.y) }), { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });
}

function draw() {
  const canvas = els.canvas;
  if (!canvas || !els.mapDetails.open) return;
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;
  const scaleFactor = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(rect.width * scaleFactor));
  canvas.height = Math.max(1, Math.floor(rect.height * scaleFactor));
  const ctx = canvas.getContext("2d");
  ctx.setTransform(scaleFactor, 0, 0, scaleFactor, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);
  const xyPoints = Object.values(tracks).flatMap((track) => track.points.map((point) => toXY(point.lat, point.lon)));
  const bounds = boundsFor(xyPoints);
  const pad = 24;
  const width = rect.width - pad * 2;
  const height = rect.height - pad * 2;
  const s = Math.min(width / (bounds.maxX - bounds.minX || 1), height / (bounds.maxY - bounds.minY || 1));
  const screen = (point) => ({ x: pad + (point.x - bounds.minX) * s + (width - (bounds.maxX - bounds.minX) * s) / 2, y: rect.height - pad - (point.y - bounds.minY) * s - (height - (bounds.maxY - bounds.minY) * s) / 2 });

  Object.entries(tracks).forEach(([name, track]) => {
    ctx.lineWidth = currentResult?.projection.trackName === name ? 3.2 : 1.4;
    ctx.strokeStyle = name === "up" ? "#087c49" : "#9d3d45";
    ctx.beginPath();
    track.points.forEach((point, index) => {
      const p = screen(toXY(point.lat, point.lon));
      if (index === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    });
    ctx.stroke();
  });

  data.controlPoints.forEach((control) => {
    const p = screen(toXY(control.lat, control.lon));
    ctx.fillStyle = control.track === "up" ? "#075c37" : "#7a2931";
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3.3, 0, Math.PI * 2);
    ctx.fill();
  });

  if (currentResult) {
    const gps = screen(toXY(currentResult.lat, currentResult.lon));
    const proj = screen(toXY(currentResult.projection.projection.lat, currentResult.projection.projection.lon));
    ctx.strokeStyle = "#d08316";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(gps.x, gps.y);
    ctx.lineTo(proj.x, proj.y);
    ctx.stroke();
    ctx.fillStyle = "#d08316";
    ctx.beginPath();
    ctx.arc(gps.x, gps.y, 5.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#0b6057";
    ctx.beginPath();
    ctx.arc(proj.x, proj.y, 4.3, 0, Math.PI * 2);
    ctx.fill();
  }
}

function startGps() {
  if (!navigator.geolocation) {
    showToast("当前浏览器不支持定位功能");
    return;
  }
  if (location.protocol === "file:") showToast("本地文件可能无法定位；建议通过 HTTPS 地址测试");
  setGpsUi("running", "正在获取定位");
  gpsWatchId = navigator.geolocation.watchPosition(
    (position) => {
      updateReadout(calculate(position.coords.latitude, position.coords.longitude, position.coords.accuracy, position.timestamp, "gps"));
      setGpsUi("running", "正在定位");
    },
    (error) => {
      const messages = { 1: "定位权限被拒绝，请在浏览器设置中允许位置权限", 2: "暂时无法获取定位，请到开阔位置重试", 3: "定位请求超时，请稍后重试" };
      showToast(messages[error.code] || error.message || "定位失败");
      stopGps();
    },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 },
  );
}

function stopGps() {
  if (gpsWatchId != null) {
    navigator.geolocation.clearWatch(gpsWatchId);
    gpsWatchId = null;
  }
  setGpsUi(currentResult?.source === "manual" ? "manual" : "idle", currentResult?.source === "manual" ? "手动坐标测试" : "定位已停止");
}

function toggleGps() {
  if (gpsWatchId == null) startGps();
  else {
    stopGps();
    showToast("已停止定位");
  }
}

els.gpsToggle.addEventListener("click", toggleGps);
els.calibrationForm.addEventListener("submit", saveCalibration);
els.actualTrack.addEventListener("change", updateCalibrationPreview);
els.actualMileage.addEventListener("input", updateCalibrationPreview);
els.targetForm.addEventListener("submit", setTarget);
els.exportCsv.addEventListener("click", exportCsv);
els.exportJson.addEventListener("click", exportJson);
els.clearSamples.addEventListener("click", clearSamples);
els.manualForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const lat = Number.parseFloat(els.manualLat.value);
  const lon = Number.parseFloat(els.manualLon.value);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    showToast("请填写正确的纬度和经度");
    return;
  }
  if (gpsWatchId != null) stopGps();
  updateReadout(calculate(lat, lon, null, Date.now(), "manual"));
  showToast("已按手动坐标完成测试");
});
els.mapDetails.addEventListener("toggle", () => {
  if (els.mapDetails.open) window.requestAnimationFrame(draw);
});
window.addEventListener("resize", () => {
  if (els.mapDetails.open) draw();
});

setTarget();
renderSamples();
setGpsUi("idle", "未开始定位");
updateCalibrationPreview();
