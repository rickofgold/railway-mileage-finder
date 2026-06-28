const data = window.TRACK_DATA;
const schema = window.FIELD_DATA_SCHEMA;
const tracks = data.tracks;
const controlsByTrack = data.controlsByTrack;

const TRACK_MODEL_VERSION = "track-data-v2.js@20260521a";
const MODEL_REFERENCE_SOURCE = JSON.stringify(data.meta.source || {});
const GPS_FRESH_MS = 15000;

const els = {
  canvas: document.querySelector("#lineCanvas"),
  lat: document.querySelector("#latValue"),
  lon: document.querySelector("#lonValue"),
  accuracy: document.querySelector("#accuracyValue"),
  time: document.querySelector("#timeValue"),
  gpsStatus: document.querySelector("#gpsStatus"),
  mileage: document.querySelector("#mileageValue"),
  track: document.querySelector("#trackValue"),
  side: document.querySelector("#sideValue"),
  offset: document.querySelector("#offsetValue"),
  projection: document.querySelector("#projectionValue"),
  segment: document.querySelector("#segmentValue"),
  rangeWarning: document.querySelector("#rangeWarning"),
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
  calibrationQuality: document.querySelector("#calibrationQuality"),
  calibrationFeedback: document.querySelector("#calibrationFeedback"),
  calibrationDirection: document.querySelector("#calibrationDirection"),
  calibrationMileage: document.querySelector("#calibrationMileage"),
  calibrationNote: document.querySelector("#calibrationNote"),
  saveCalibration: document.querySelector("#saveCalibrationBtn"),
  calibrationCount: document.querySelector("#calibrationCount"),
  calibrationList: document.querySelector("#calibrationList"),
  clearCalibrations: document.querySelector("#clearCalibrationsBtn"),
  entityQuality: document.querySelector("#entityQuality"),
  entityFeedback: document.querySelector("#entityFeedback"),
  entityCategory: document.querySelector("#entityCategory"),
  entityName: document.querySelector("#entityName"),
  entityDirection: document.querySelector("#entityDirection"),
  entityMileage: document.querySelector("#entityMileage"),
  entitySide: document.querySelector("#entitySide"),
  entityNote: document.querySelector("#entityNote"),
  saveEntity: document.querySelector("#saveEntityBtn"),
  entityCount: document.querySelector("#entityCount"),
  entityList: document.querySelector("#entityList"),
  clearEntities: document.querySelector("#clearEntitiesBtn"),
  exportCalibrationCsv: document.querySelector("#exportCalibrationCsvBtn"),
  exportEntityCsv: document.querySelector("#exportEntityCsvBtn"),
  exportBackupJson: document.querySelector("#exportBackupJsonBtn"),
};

let gpsWatchId = null;
let currentResult = null;
let lastLiveGpsResult = null;
let lastGpsCoords = null;
let currentTarget = { name: "网门", mileageKm: 727.3, side: "up" };
let calibrations = loadRecords(schema.storageKeys.mileageCalibrations);
let entities = loadRecords(schema.storageKeys.fieldEntities);
let calibrationFeedbackTimer = null;
let entityFeedbackTimer = null;

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
  const totalM = Math.round(km * 10000) / 10;
  const k = Math.floor(totalM / 1000);
  const m = totalM - k * 1000;
  return `K${k}+${m.toFixed(1).padStart(5, "0")}`;
}

function parseMileage(value) {
  const text = String(value || "").trim().toUpperCase();
  if (!text) return null;
  const plus = text.match(/^K?\s*(\d{3,4})\s*\+\s*(\d{1,3}(?:\.\d+)?)$/);
  if (plus) return Number(plus[1]) + Number(plus[2]) / 1000;
  const dotted = text.match(/^K?\s*(\d{3,4}(?:\.\d+)?)$/);
  if (dotted) return Number(dotted[1]);
  return null;
}

function formatDistance(meters, signed = false) {
  if (!Number.isFinite(meters)) return "--";
  const prefix = signed ? (meters >= 0 ? "+" : "-") : "";
  return `${prefix}${Math.abs(meters).toFixed(2)} m`;
}

function directionLabel(direction) {
  if (direction === "up") return "上行";
  if (direction === "down") return "下行";
  return "不确定";
}

function modelDirectionFromResult(result) {
  if (!result?.projection?.trackName) return "unknown";
  return result.projection.trackName === "up" ? "up" : "down";
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
  return { mileageKm: lerp(a.mileageKm, b.mileageKm, ratio), segment };
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
    const rawProjectionT = (wx * vx + wy * vy) / len2;
    const clampedProjectionT = Math.max(0, Math.min(1, rawProjectionT));
    const proj = { x: a.x + vx * clampedProjectionT, y: a.y + vy * clampedProjectionT };
    const distanceM = Math.hypot(p.x - proj.x, p.y - proj.y);
    const rawCross = vx * wy - vy * wx;
    const signedOffsetM = rawCross * track.beijingDirectionSign >= 0 ? distanceM : -distanceM;
    const alongM = lerp(track.distanceAlongM[i], track.distanceAlongM[i + 1], clampedProjectionT);
    if (!best || distanceM < best.distanceM) {
      best = {
        trackName,
        index: i,
        t: clampedProjectionT,
        rawProjectionT,
        clampedProjectionT,
        distanceM,
        signedOffsetM,
        alongM,
        projection: { lat: lerp(pointA.lat, pointB.lat, clampedProjectionT), lon: lerp(pointA.lon, pointB.lon, clampedProjectionT) },
      };
    }
  }
  return best;
}

function rangeInfoForProjection(projection) {
  const track = tracks[projection.trackName];
  const lastSegmentIndex = track.points.length - 2;
  let rangeStatus = "in_coverage";
  let nearestEndpointType = "";
  let nearestEndpointMileageKm = null;
  let distanceToEndpointM = null;
  let beyondEndpointAlongM = null;

  if (projection.index === 0 && projection.rawProjectionT < 0) {
    rangeStatus = "beyond_start";
    nearestEndpointType = "start";
    distanceToEndpointM = projection.distanceM;
    beyondEndpointAlongM = Math.max(0, -projection.rawProjectionT * (track.distanceAlongM[1] - track.distanceAlongM[0]));
    nearestEndpointMileageKm = mileageAt(projection.trackName, track.distanceAlongM[0])?.mileageKm ?? null;
  } else if (projection.index === lastSegmentIndex && projection.rawProjectionT > 1) {
    rangeStatus = "beyond_end";
    nearestEndpointType = "end";
    distanceToEndpointM = projection.distanceM;
    beyondEndpointAlongM = Math.max(0, (projection.rawProjectionT - 1) * (track.distanceAlongM[lastSegmentIndex + 1] - track.distanceAlongM[lastSegmentIndex]));
    nearestEndpointMileageKm = mileageAt(projection.trackName, track.distanceAlongM[lastSegmentIndex + 1])?.mileageKm ?? null;
  }

  return {
    range_status: rangeStatus,
    nearest_endpoint_type: nearestEndpointType,
    nearest_endpoint_mileage_km: nearestEndpointMileageKm,
    distance_to_endpoint_m: distanceToEndpointM,
    beyond_endpoint_along_m: beyondEndpointAlongM,
  };
}

function calculate(lat, lon, accuracy = null, timestamp = Date.now(), coords = null) {
  const candidates = Object.keys(tracks).map((trackName) => projectToTrack(trackName, lat, lon));
  const projection = candidates.reduce((best, item) => (!best || item.distanceM < best.distanceM ? item : best), null);
  const range = rangeInfoForProjection(projection);
  const mileage = range.range_status === "in_coverage" ? mileageAt(projection.trackName, projection.alongM) : null;
  const side =
    Math.abs(projection.signedOffsetM) < 0.5 ? "线上" : projection.signedOffsetM > 0 ? "上行侧" : "下行侧";
  return { lat, lon, accuracy, timestamp, projection, mileage, side, coords, range };
}

function updateReadout(result, source = "manual") {
  currentResult = result;
  if (source === "gps") lastLiveGpsResult = result;
  els.lat.textContent = result.lat.toFixed(8);
  els.lon.textContent = result.lon.toFixed(8);
  els.accuracy.textContent = result.accuracy == null ? "--" : `${result.accuracy.toFixed(1)} m`;
  els.time.textContent = new Date(result.timestamp).toLocaleString();
  els.mileage.textContent = result.range.range_status === "in_coverage" && result.mileage ? formatMileage(result.mileage.mileageKm) : "超出参考轨迹覆盖范围";
  els.track.textContent = tracks[result.projection.trackName].label;
  els.side.textContent = result.side;
  els.side.className = result.side === "上行侧" ? "side-up" : result.side === "下行侧" ? "side-down" : "";
  els.offset.textContent = formatDistance(result.projection.signedOffsetM, true);
  els.projection.textContent = `${result.projection.projection.lat.toFixed(8)}, ${result.projection.projection.lon.toFixed(8)}`;
  if (result.mileage) {
    const extrapolated = result.mileage.segment.extrapolated ? "（外推）" : "";
    els.segment.textContent = `${result.mileage.segment.a.name} 到 ${result.mileage.segment.b.name}${extrapolated}`;
  } else {
    els.segment.textContent = "--";
  }
  updateRangeWarning(result);
  updateQualityDisplays();
  draw();
  updateTargetGuidance();
}

function updateRangeWarning(result) {
  if (result.range.range_status === "in_coverage") {
    els.rangeWarning.hidden = true;
    els.rangeWarning.textContent = "";
    return;
  }
  const endpointType = result.range.nearest_endpoint_type === "start" ? "起点" : "终点";
  const trackLabel = tracks[result.projection.trackName].label;
  const endpointMileage = formatMileage(result.range.nearest_endpoint_mileage_km);
  const distance = formatDistance(result.range.distance_to_endpoint_m);
  const beyond = Number.isFinite(result.range.beyond_endpoint_along_m)
    ? `\n沿端点延长方向约 ${result.range.beyond_endpoint_along_m.toFixed(1)} 米`
    : "";
  els.rangeWarning.textContent = `已超出【${trackLabel}】参考轨迹覆盖范围\n\n最近端点：${endpointType} ${endpointMileage}\n距最近端点：${distance}${beyond}\n\n当前模型K值无效，不可用于实际里程判断。`;
  els.rangeWarning.hidden = false;
}

function setGpsStatus(message, level = "muted") {
  els.gpsStatus.textContent = message;
  els.gpsStatus.className = `notice ${level}`;
}

function gpsQuality(result = lastLiveGpsResult) {
  if (!result) return { flag: "none", label: "请先开始定位并等待定位成功", className: "muted" };
  if (Date.now() - result.timestamp > GPS_FRESH_MS) {
    return { flag: "stale", label: "定位时间超过15秒，请等待新的GPS位置", className: "bad" };
  }
  if (!Number.isFinite(result.lat) || !Number.isFinite(result.lon) || result.accuracy == null) {
    return { flag: "invalid", label: "当前GPS数据不完整", className: "bad" };
  }
  if (result.accuracy > 30) {
    return { flag: "poor", label: "当前GPS精度较差，不建议作为高精度校验点。可继续保存为 poor。", className: "bad" };
  }
  if (result.accuracy > 10) {
    return { flag: "medium", label: "当前GPS精度中等，可保存为 medium。", className: "warn" };
  }
  return { flag: "good", label: "当前GPS精度良好，可保存为 good。", className: "good" };
}

function updateQualityDisplays() {
  const q = gpsQuality();
  els.calibrationQuality.textContent = q.label;
  els.entityQuality.textContent = q.label;
  els.calibrationQuality.className = `quality ${q.className}`;
  els.entityQuality.className = `quality ${q.className}`;
}

function ensureFreshGps() {
  const q = gpsQuality();
  if (!lastLiveGpsResult || ["none", "stale", "invalid"].includes(q.flag)) {
    alert("请先开始定位并等待定位成功。");
    return null;
  }
  return { result: lastLiveGpsResult, quality: q };
}

function modelSnapshot(result) {
  const direction = modelDirectionFromResult(result);
  return {
    model_direction: direction,
    model_mileage_km: result.range.range_status === "in_coverage" ? (result.mileage?.mileageKm ?? null) : null,
    model_mileage_text: result.range.range_status === "in_coverage" && result.mileage ? formatMileage(result.mileage.mileageKm) : "超出参考轨迹覆盖范围",
    model_track_offset_m: result.projection.signedOffsetM,
    model_line_side: result.side,
    model_confidence: result.range.range_status === "in_coverage" ? (result.mileage?.segment?.extrapolated ? "extrapolated" : "normal") : "out_of_coverage",
    model_reference_source: MODEL_REFERENCE_SOURCE,
    track_model_version: TRACK_MODEL_VERSION,
    model_range_status: result.range.range_status,
    nearest_endpoint_type: result.range.nearest_endpoint_type,
    nearest_endpoint_mileage_km: result.range.nearest_endpoint_mileage_km,
    distance_to_endpoint_m: result.range.distance_to_endpoint_m,
    beyond_endpoint_along_m: result.range.beyond_endpoint_along_m,
  };
}

function gpsSnapshot(result) {
  const coords = result.coords || {};
  return {
    latitude: result.lat,
    longitude: result.lon,
    gps_accuracy_m: result.accuracy,
    gps_altitude_m: coords.altitude ?? null,
    gps_heading_deg: coords.heading ?? null,
    gps_speed_mps: coords.speed ?? null,
  };
}

function selectedDirection(value, result) {
  if (value === "auto") return modelDirectionFromResult(result);
  return value;
}

function saveCalibration() {
  const fresh = ensureFreshGps();
  if (!fresh) return;
  const actualMileage = parseMileage(els.calibrationMileage.value);
  if (!Number.isFinite(actualMileage)) {
    alert("请输入有效的实际里程，例如 751.780、K751+780 或 K751.780。");
    return;
  }
  const result = fresh.result;
  const model = modelSnapshot(result);
  const actualDirection = selectedDirection(els.calibrationDirection.value, result);
  const record = {
    record_id: `CAL-${Date.now()}`,
    record_type: schema.recordTypes.mileageCalibration,
    created_at: new Date().toISOString(),
    captured_at: new Date(result.timestamp).toISOString(),
    actual_direction: actualDirection,
    actual_mileage_km: actualMileage,
    note: els.calibrationNote.value.trim(),
    ...gpsSnapshot(result),
    ...model,
    mileage_difference_m: model.model_mileage_km == null ? null : Number(((model.model_mileage_km - actualMileage) * 1000).toFixed(3)),
    direction_match: actualDirection === model.model_direction,
    quality_flag: fresh.quality.flag,
  };
  calibrations.push(record);
  saveRecords(schema.storageKeys.mileageCalibrations, calibrations);
  els.calibrationMileage.value = "";
  els.calibrationNote.value = "";
  renderCalibrations();
  showSaveFeedback(
    els.calibrationFeedback,
    `已保存校验点：${directionLabel(actualDirection)} ${formatMileage(actualMileage)}，GPS精度 ${Number(result.accuracy).toFixed(1)} 米，当前共 ${calibrations.length} 条。${outOfCoverageSaveNote(result)}`,
    fresh.quality.flag,
    "calibration",
  );
}

function saveEntity() {
  const fresh = ensureFreshGps();
  if (!fresh) return;
  const entityName = els.entityName.value.trim();
  if (!entityName) {
    alert("请输入实体名称。");
    return;
  }
  const mileageText = els.entityMileage.value.trim();
  const actualMileage = mileageText ? parseMileage(mileageText) : null;
  if (mileageText && !Number.isFinite(actualMileage)) {
    alert("实际里程格式不正确，可留空，或输入 751.780 / K751+780。");
    return;
  }
  const result = fresh.result;
  const record = {
    entity_id: `ENT-${Date.now()}`,
    record_type: schema.recordTypes.fieldEntity,
    created_at: new Date().toISOString(),
    captured_at: new Date(result.timestamp).toISOString(),
    entity_category: els.entityCategory.value,
    entity_name: entityName,
    actual_direction: selectedDirection(els.entityDirection.value, result),
    actual_mileage_km: actualMileage,
    side: els.entitySide.value || "unknown",
    note: els.entityNote.value.trim(),
    ...gpsSnapshot(result),
    ...modelSnapshot(result),
    quality_flag: fresh.quality.flag,
  };
  entities.push(record);
  saveRecords(schema.storageKeys.fieldEntities, entities);
  els.entityName.value = "";
  els.entityMileage.value = "";
  els.entityNote.value = "";
  renderEntities();
  showSaveFeedback(
    els.entityFeedback,
    `已保存实体点：${record.entity_category} ${record.entity_name}，模型 ${record.model_mileage_text}，GPS精度 ${Number(result.accuracy).toFixed(1)} 米，当前共 ${entities.length} 条。${outOfCoverageSaveNote(result)}`,
    fresh.quality.flag,
    "entity",
  );
}

function outOfCoverageSaveNote(result) {
  return result.range.range_status === "in_coverage" ? "" : " 模型K值无效，已保留GPS、最近端点信息和实际K值。";
}

function showSaveFeedback(element, message, qualityFlag, kind) {
  const timerName = kind === "calibration" ? "calibrationFeedbackTimer" : "entityFeedbackTimer";
  if (timerName === "calibrationFeedbackTimer" && calibrationFeedbackTimer) clearTimeout(calibrationFeedbackTimer);
  if (timerName === "entityFeedbackTimer" && entityFeedbackTimer) clearTimeout(entityFeedbackTimer);
  const className = qualityFlag === "poor" ? "bad" : qualityFlag === "medium" ? "warn" : "good";
  const prefix =
    qualityFlag === "poor"
      ? "保存成功，GPS 精度较差但已保存为 poor。"
      : qualityFlag === "medium"
        ? "保存成功，GPS 精度中等。"
        : "保存成功。";
  element.textContent = `${prefix} ${message}`;
  element.className = `save-feedback ${className}`;
  element.hidden = false;
  const clear = () => {
    element.hidden = true;
    element.textContent = "";
  };
  if (timerName === "calibrationFeedbackTimer") calibrationFeedbackTimer = setTimeout(clear, 3000);
  else entityFeedbackTimer = setTimeout(clear, 3000);
}

function loadRecords(key) {
  try {
    const parsed = JSON.parse(window.localStorage?.getItem(key) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveRecords(key, records) {
  window.localStorage?.setItem(key, JSON.stringify(records));
}

function renderCalibrations() {
  els.calibrationCount.textContent = String(calibrations.length);
  if (!calibrations.length) {
    els.calibrationList.innerHTML = '<p class="empty-row">暂无现场校验记录。</p>';
    return;
  }
  els.calibrationList.innerHTML = calibrations
    .slice()
    .sort((a, b) => String(b.captured_at).localeCompare(String(a.captured_at)))
    .slice(0, 20)
    .map((r) => `<article class="record-item">
      <div><strong>${new Date(r.captured_at).toLocaleString()}</strong></div>
      <div>实际：${directionLabel(r.actual_direction)} ${formatMileage(r.actual_mileage_km)}</div>
      <div>模型：${directionLabel(r.model_direction)} ${escapeHtml(r.model_mileage_text || formatMileage(r.model_mileage_km))}</div>
      <div>误差：${r.mileage_difference_m == null ? "--" : formatDistance(r.mileage_difference_m, true)}；GPS精度：${formatDistance(r.gps_accuracy_m)}</div>
      <div>${escapeHtml(r.note || "")}</div>
      <button class="small danger" type="button" data-delete-calibration="${escapeHtml(r.record_id)}">删除</button>
    </article>`)
    .join("");
}

function renderEntities() {
  els.entityCount.textContent = String(entities.length);
  if (!entities.length) {
    els.entityList.innerHTML = '<p class="empty-row">暂无实体记录。</p>';
    return;
  }
  els.entityList.innerHTML = entities
    .slice()
    .sort((a, b) => String(b.captured_at).localeCompare(String(a.captured_at)))
    .slice(0, 20)
    .map((r) => `<article class="record-item">
      <div><strong>${escapeHtml(r.entity_category)}：${escapeHtml(r.entity_name)}</strong></div>
      <div>${directionLabel(r.actual_direction)}；模型 ${escapeHtml(r.model_mileage_text || formatMileage(r.model_mileage_km))}</div>
      <div>GPS精度：${formatDistance(r.gps_accuracy_m)}；保存时间：${new Date(r.created_at).toLocaleString()}</div>
      <div>${escapeHtml(r.note || "")}</div>
      <button class="small danger" type="button" data-delete-entity="${escapeHtml(r.entity_id)}">删除</button>
    </article>`)
    .join("");
}

function deleteCalibration(id) {
  calibrations = calibrations.filter((r) => r.record_id !== id);
  saveRecords(schema.storageKeys.mileageCalibrations, calibrations);
  renderCalibrations();
}

function deleteEntity(id) {
  entities = entities.filter((r) => r.entity_id !== id);
  saveRecords(schema.storageKeys.fieldEntities, entities);
  renderEntities();
}

function exportCalibrationCsv() {
  exportCsv("铁路里程现场校验", calibrations, calibrationFields);
}

function exportEntityCsv() {
  exportCsv("铁路实体点采集", entities, entityFields);
}

const calibrationFields = [
  "record_id", "record_type", "created_at", "captured_at", "actual_direction", "actual_mileage_km", "note",
  "latitude", "longitude", "gps_accuracy_m", "gps_altitude_m", "gps_heading_deg", "gps_speed_mps",
  "model_direction", "model_mileage_km", "model_mileage_text", "model_track_offset_m", "model_line_side",
  "model_confidence", "model_reference_source", "track_model_version", "model_range_status", "nearest_endpoint_type",
  "nearest_endpoint_mileage_km", "distance_to_endpoint_m", "beyond_endpoint_along_m", "mileage_difference_m", "direction_match", "quality_flag",
];

const entityFields = [
  "entity_id", "record_type", "created_at", "captured_at", "entity_category", "entity_name", "actual_direction",
  "actual_mileage_km", "side", "note", "latitude", "longitude", "gps_accuracy_m", "gps_altitude_m",
  "gps_heading_deg", "gps_speed_mps", "model_direction", "model_mileage_km", "model_mileage_text", "model_track_offset_m",
  "model_line_side", "model_confidence", "model_reference_source", "track_model_version", "model_range_status",
  "nearest_endpoint_type", "nearest_endpoint_mileage_km", "distance_to_endpoint_m", "beyond_endpoint_along_m", "quality_flag",
];

function exportCsv(label, records, fields) {
  const sorted = records.slice().sort((a, b) => String(a.captured_at).localeCompare(String(b.captured_at)));
  if (!sorted.length) {
    alert("没有可导出的记录。");
    return;
  }
  const csv = [
    fields.join(","),
    ...sorted.map((row) => fields.map((field) => csvCell(row[field])).join(",")),
  ].join("\r\n");
  download(`${label}_${timestampForFile()}.csv`, `\uFEFF${csv}`, "text/csv;charset=utf-8");
}

function exportBackupJson() {
  const payload = {
    exported_at: new Date().toISOString(),
    app_version: schema.appVersion,
    app_version_label: schema.appVersionLabel,
    track_model_version: TRACK_MODEL_VERSION,
    model_reference_source: data.meta.source || {},
    mileage_calibrations: calibrations.slice().sort((a, b) => String(a.captured_at).localeCompare(String(b.captured_at))),
    field_entities: entities.slice().sort((a, b) => String(a.captured_at).localeCompare(String(b.captured_at))),
  };
  download(`铁路里程定位数据备份_${timestampForFile()}.json`, JSON.stringify(payload, null, 2), "application/json;charset=utf-8");
}

function csvCell(value) {
  const text = value == null ? "" : String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
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
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function setTarget() {
  const mileageKm = parseMileage(els.targetMileage.value);
  currentTarget = {
    name: els.targetName.value.trim() || "目标",
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
  els.targetSummary.textContent = `${currentTarget.name} ${formatMileage(currentTarget.mileageKm)} ${formatTargetSide(currentTarget.side)}`;
  if (!currentResult?.mileage?.mileageKm || currentResult.range?.range_status !== "in_coverage") {
    els.targetDelta.textContent = "--";
    els.targetMove.textContent = currentResult?.range?.range_status === "in_coverage" ? "--" : "当前位置超出参考轨迹覆盖范围";
    els.targetSideHint.textContent = currentResult?.range?.range_status === "in_coverage" ? "--" : "模型K值无效";
    return;
  }
  const deltaM = (currentTarget.mileageKm - currentResult.mileage.mileageKm) * 1000;
  els.targetDelta.textContent = formatDistance(deltaM, true);
  els.targetMove.textContent = Math.abs(deltaM) < 3 ? "已接近目标里程" : deltaM > 0 ? "向里程增大方向走" : "向里程减小方向走";
  els.targetSideHint.textContent = sideHint(currentResult.side, currentTarget.side);
}

function formatTargetSide(side) {
  if (side === "up") return "上行侧";
  if (side === "down") return "下行侧";
  return "任意侧";
}

function sideHint(currentSide, targetSide) {
  if (targetSide === "any") return "目标未指定侧别";
  const wanted = targetSide === "up" ? "上行侧" : "下行侧";
  if (currentSide === "线上") return `靠近${wanted}`;
  if (currentSide === wanted) return `已在${wanted}`;
  return `向${wanted}移动`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
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
  const s = Math.min(width / (bounds.maxX - bounds.minX || 1), height / (bounds.maxY - bounds.minY || 1));
  function screen(point) {
    return {
      x: pad + (point.x - bounds.minX) * s + (width - (bounds.maxX - bounds.minX) * s) / 2,
      y: rect.height - pad - (point.y - bounds.minY) * s - (height - (bounds.maxY - bounds.minY) * s) / 2,
    };
  }
  Object.entries(tracks).forEach(([name, track]) => {
    ctx.lineWidth = currentResult?.projection.trackName === name ? 3 : 1.8;
    ctx.strokeStyle = name === "up" ? "#126c64" : "#8a3f55";
    ctx.beginPath();
    track.points.forEach((point, i) => {
      const p = screen(toXY(point.lat, point.lon));
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    });
    ctx.stroke();
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
    setGpsStatus("定位失败：定位不可用", "bad");
    return;
  }
  if (location.protocol !== "https:" && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") {
    setGpsStatus("当前页面不是HTTPS，无法可靠使用定位", "warn");
  } else {
    setGpsStatus("正在请求定位权限", "muted");
  }
  if (gpsWatchId != null) stopGps(false);
  setGpsStatus("正在获取GPS", "muted");
  gpsWatchId = navigator.geolocation.watchPosition(
    (position) => {
      lastGpsCoords = position.coords;
      updateReadout(
        calculate(position.coords.latitude, position.coords.longitude, position.coords.accuracy, position.timestamp, position.coords),
        "gps",
      );
      setGpsStatus("定位成功", "good");
    },
    (error) => {
      const messages = {
        1: "定位失败：权限被拒绝",
        2: "定位失败：定位不可用",
        3: "定位失败：定位超时",
      };
      setGpsStatus(messages[error.code] || `定位失败：${error.message}`, "bad");
      stopGps(false);
    },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 },
  );
  els.startGps.disabled = true;
  els.stopGps.disabled = false;
}

function stopGps(updateStatus = true) {
  if (gpsWatchId != null) {
    navigator.geolocation.clearWatch(gpsWatchId);
    gpsWatchId = null;
  }
  if (updateStatus) setGpsStatus("已停止定位", "muted");
  els.startGps.disabled = false;
  els.stopGps.disabled = true;
}

els.startGps.addEventListener("click", startGps);
els.stopGps.addEventListener("click", () => stopGps(true));
els.setTarget.addEventListener("click", setTarget);
els.saveCalibration.addEventListener("click", saveCalibration);
els.saveEntity.addEventListener("click", saveEntity);
els.exportCalibrationCsv.addEventListener("click", exportCalibrationCsv);
els.exportEntityCsv.addEventListener("click", exportEntityCsv);
els.exportBackupJson.addEventListener("click", exportBackupJson);
els.clearCalibrations.addEventListener("click", () => {
  if (!calibrations.length || !confirm("确认清空全部现场校验记录？")) return;
  calibrations = [];
  saveRecords(schema.storageKeys.mileageCalibrations, calibrations);
  renderCalibrations();
});
els.clearEntities.addEventListener("click", () => {
  if (!entities.length || !confirm("确认清空全部实体记录？")) return;
  entities = [];
  saveRecords(schema.storageKeys.fieldEntities, entities);
  renderEntities();
});
els.calibrationList.addEventListener("click", (event) => {
  const id = event.target?.dataset?.deleteCalibration;
  if (id) deleteCalibration(id);
});
els.entityList.addEventListener("click", (event) => {
  const id = event.target?.dataset?.deleteEntity;
  if (id) deleteEntity(id);
});
els.form.addEventListener("submit", (event) => {
  event.preventDefault();
  const lat = Number.parseFloat(els.manualLat.value);
  const lon = Number.parseFloat(els.manualLon.value);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
  updateReadout(calculate(lat, lon), "manual");
});
window.addEventListener("resize", draw);

setTarget();
updateReadout(calculate(Number.parseFloat(els.manualLat.value), Number.parseFloat(els.manualLon.value)), "manual");
renderCalibrations();
renderEntities();
