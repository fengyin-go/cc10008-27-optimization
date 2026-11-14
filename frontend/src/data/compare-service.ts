import {
  buildItem,
  canonicalFieldSignature,
  configSignature,
  hierarchyKeyOf,
  parentHierarchyKeyOf,
  dedupeItems,
  describeReason,
  drillReport as drillFromReport,
  latestReportForPlan,
  needsThresholdRecompute,
  normalizeToken,
  parseFieldList,
  publishedReportForPlan,
  reevaluateItem,
  resolveColumns,
  sameFieldSet,
  sameOrder,
  scanLevel,
  summarize,
  THRESHOLD_POLICY,
  typeMismatch,
  CRITICAL_BAND_HIGH_RATIO,
  CRITICAL_BAND_LOW_RATIO,
} from './compare-engine'
import type {
  ComparisonDataset,
  ComparisonItem,
  ComparisonPlan,
  ComparisonReport,
  DrillResult,
  ReportReason,
} from './compare-types'
import {
  datasetById,
  datasets,
  planById,
  plans,
  reports,
  savePlan,
  saveReports,
} from './compare-workspace'
import { listRows, saveRows } from './local-store'

export type GenerateResult = {
  ok: boolean
  message: string
  report: ComparisonReport | null
  reusedFrom: string | null
  detail: {
    reason: ReportReason
    fullScan: boolean
    scannedSlices: number
    reusedSlices: number
    recomputedSlices: number
    itemCount: number
    unclassifiedCount: number
  } | null
}

export type UpdatePlanResult = {
  ok: boolean
  message: string
  plan: ComparisonPlan | null
  generated: ComparisonReport | null
  cosmeticOnly: boolean
}

export type PlanSnapshot = {
  plan: ComparisonPlan
  published: ComparisonReport | null
  candidate: ComparisonReport | null
  latest: ComparisonReport | null
  versionCount: number
}

let clockOffset = 0

/** 时间戳可注入：同一毫秒内连续操作时保证报告时间和版本可区分。 */
function nowIso(): string {
  clockOffset += 1
  return new Date(Date.now() + clockOffset).toISOString()
}

function nextVersion(existing: ComparisonReport[], planId: number): number {
  const versions = existing.filter((report) => report.planId === planId).map((report) => report.version)
  return versions.length === 0 ? 1 : Math.max(...versions) + 1
}

function reportIdFor(planId: number, version: number): string {
  return `cmp-${planId}-v${String(version).padStart(3, '0')}-${Date.now().toString(36)}`
}

function safeDataset(id: string): ComparisonDataset {
  const found = datasetById(id)
  if (!found) throw new Error(`没有找到数据集「${id}」`)
  return found
}

function validatePlan(plan: ComparisonPlan): { base: ComparisonDataset; compare: ComparisonDataset } {
  const base = safeDataset(plan.baseDatasetId)
  const compare = safeDataset(plan.compareDatasetId)
  const names = [...plan.dimensions, ...plan.metrics]
  const mismatch = typeMismatch(base, compare, names)
  if (mismatch) throw new Error(mismatch)
  resolveColumns(base, names)
  resolveColumns(compare, names)
  return { base, compare }
}

function planReason(
  previous: ComparisonReport | null,
  plan: ComparisonPlan,
  base: ComparisonDataset,
  compare: ComparisonDataset,
): ReportReason {
  if (!previous) return 'initial'
  const dimensionsChanged = canonicalFieldSignature(plan.dimensions) !== canonicalFieldSignature(previous.dimensions)
  const metricsChanged = canonicalFieldSignature(plan.metrics) !== canonicalFieldSignature(previous.metrics)
  const datasetChanged =
    plan.baseDatasetId !== previous.baseDatasetId ||
    plan.compareDatasetId !== previous.compareDatasetId ||
    base.snapshotId !== previous.baselineSnapshotId ||
    compare.snapshotId !== previous.comparisonSnapshotId
  if (datasetChanged) return 'snapshot'
  if (dimensionsChanged) return 'dimensions'
  if (metricsChanged) return 'metrics'
  const thresholdChanged = plan.threshold !== previous.threshold
  const significanceChanged = plan.significance !== previous.significance
  if (thresholdChanged && significanceChanged) return 'threshold+significance'
  if (thresholdChanged) return 'threshold'
  if (significanceChanged) return 'significance'
  return 'manual'
}

function sortItems(items: ComparisonItem[]): ComparisonItem[] {
  return [...items].sort((a, b) => {
    if (a.level !== b.level) return a.level - b.level
    const hierarchy = a.hierarchyKey.localeCompare(b.hierarchyKey)
    if (hierarchy !== 0) return hierarchy
    return a.metricKey.localeCompare(b.metricKey)
  })
}

function fullScanItems(
  base: ComparisonDataset,
  compare: ComparisonDataset,
  plan: ComparisonPlan,
): ComparisonItem[] {
  const items: ComparisonItem[] = []
  const levels = Math.max(1, plan.dimensions.length)
  const dimensionKeys = plan.dimensions.map(normalizeToken)
  for (let level = 0; level < levels; level += 1) {
    const scans = scanLevel(base, compare, plan.dimensions, plan.metrics, { level })
    for (const stats of scans) {
      plan.metrics.forEach((metric, metricIndex) => {
        const item = buildItem(stats, metricIndex, {
          level,
          dimensionKeys,
          dimensionLabels: plan.dimensions,
          metric,
          metricKey: normalizeToken(metric),
          baseDatasetName: base.name,
          compareDatasetName: compare.name,
          threshold: plan.threshold,
          significance: plan.significance,
        })
        item.evidence = item.evidence.slice()
        items.push(item)
      })
    }
  }
  return sortItems(dedupeItems(items))
}

function reuseItems(params: {
  prior: ComparisonReport
  plan: ComparisonPlan
  base: ComparisonDataset
  compare: ComparisonDataset
  thresholdChanged: boolean
  significanceChanged: boolean
}): { items: ComparisonItem[]; recomputedSlices: number } {
  const { prior, plan } = params
  const recomputeSignificance = params.significanceChanged
  const recomputeThreshold = params.thresholdChanged
  const priorItems = dedupeItems(prior.items)
  const items = priorItems.map((source) => {
    // 只有阈值判定会翻转或落在临界带的切片才真正重算；其余切片的数值与判定原样复用。
    const criticalThreshold = recomputeThreshold
      ? needsThresholdRecompute(source, prior.threshold, plan.threshold)
      : false
    return reevaluateItem(source, {
      threshold: plan.threshold,
      significance: plan.significance,
      // 阈值标记始终按新阈值重算一次（只是对已存数值做比较，不重扫维度），
      // 这样证据文本里不会残留旧阈值的说法。
      recomputeThreshold: true,
      recomputeSignificance,
      markRecomputed: criticalThreshold || recomputeSignificance,
      sourceReportId: prior.id,
      baseDatasetName: params.base.name,
      compareDatasetName: params.compare.name,
    })
  })
  const recomputedSlices = new Set(
    items.filter((item) => item.judgmentRecomputed).map((item) => item.hierarchyKey),
  ).size
  return { items: sortItems(dedupeItems(items)), recomputedSlices }
}

/** 生成对比报告：只调阈值时复用未变化切片，仅重算临界附近。 */
export function generateComparisonReport(planId: number, options: { forceFullScan?: boolean } = {}): GenerateResult {
  const plan = planById(planId)
  if (!plan) {
    return { ok: false, message: `没有找到对比方案 ${planId}`, report: null, reusedFrom: null, detail: null }
  }
  let base: ComparisonDataset
  let compare: ComparisonDataset
  try {
    const resolved = validatePlan(plan)
    base = resolved.base
    compare = resolved.compare
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : '对比方案校验失败',
      report: null,
      reusedFrom: null,
      detail: null,
    }
  }

  if (plan.dimensions.length === 0 || plan.metrics.length === 0) {
    return { ok: false, message: '对比方案至少要配置一个对比维度和一个对比指标', report: null, reusedFrom: null, detail: null }
  }

  const allReports = reports()
  const prior = latestReportForPlan(allReports, plan.id)
  const activePublished = publishedReportForPlan(allReports, plan.id)
  const reason = planReason(prior, plan, base, compare)

  // 字段集合没变、只是顺序/大小写变化时，明细键（按“维度=值”排序）保持稳定，
  // 不会出现虚假新增；但层级结构变了，需要按新顺序重建层级。
  const dimensionSetChanged = prior
    ? canonicalFieldSignature(prior.dimensions) !== canonicalFieldSignature(plan.dimensions)
    : false
  const metricSetChanged = prior
    ? canonicalFieldSignature(prior.metrics) !== canonicalFieldSignature(plan.metrics)
    : false
  const dimensionOrderChanged = prior ? !sameOrder(prior.dimensions, plan.dimensions) : false

  const structuralChange =
    !prior ||
    options.forceFullScan === true ||
    prior.state === 'revoked' ||
    dimensionSetChanged ||
    metricSetChanged ||
    dimensionOrderChanged ||
    prior.items.some((item) => item.evaluatedThreshold !== prior.threshold || item.evaluatedSignificance !== prior.significance) ||
    prior.baseDatasetId !== plan.baseDatasetId ||
    prior.compareDatasetId !== plan.compareDatasetId ||
    prior.baselineSnapshotId !== base.snapshotId ||
    prior.comparisonSnapshotId !== compare.snapshotId

  const thresholdChanged = prior ? plan.threshold !== prior.threshold : true
  const significanceChanged = prior ? plan.significance !== prior.significance : true

  let items: ComparisonItem[] = []
  let scannedSlices = 0
  let reusedSlices = 0
  let recomputedSlices = 0
  const fullScan = structuralChange

  if (structuralChange) {
    items = fullScanItems(base, compare, plan)
    const sliceCount = new Set(items.map((item) => item.hierarchyKey)).size
    scannedSlices = sliceCount
    recomputedSlices = sliceCount
    reusedSlices = 0
  } else if (prior) {
    const reused = reuseItems({ prior, plan, base, compare, thresholdChanged, significanceChanged })
    items = reused.items
    const priorSliceCount = new Set(items.map((item) => item.hierarchyKey)).size
    recomputedSlices = reused.recomputedSlices
    scannedSlices = 0
    // 显著性变化时全量判定重算，但数据仍来自上一次报告；阈值变化只重算临界切片。
    reusedSlices = Math.max(0, priorSliceCount - recomputedSlices)
  }

  // “当前判定”永远代表最新一次执行结果；旧版本继续留档，不会被新结果挤掉。
  const version = nextVersion(allReports, plan.id)
  const timestamp = nowIso()
  const summary = summarize(items)
  // 首次生效、且方案处于「已启用」时才自动发布；之后所有重算都落为候选，必须人工发布。
  const shouldAutoPublish =
    plan.disabled !== true &&
    plan.status === '已启用' &&
    activePublished === null &&
    reason === 'initial' &&
    !options.forceFullScan

  const report: ComparisonReport = {
    id: reportIdFor(plan.id, version),
    planId: plan.id,
    planCode: plan.code,
    version,
    state: shouldAutoPublish ? 'published' : 'candidate',
    reason,
    // 全量重建时没有复用任何旧明细，父版本留空；增量重算才标注复用来源。
    parentReportId: structuralChange ? null : prior?.id ?? null,
    createdAt: timestamp,
    publishedAt: shouldAutoPublish ? timestamp : null,
    revokedAt: null,
    supersededAt: null,
    baseDatasetId: plan.baseDatasetId,
    compareDatasetId: plan.compareDatasetId,
    baseDatasetName: base.name,
    compareDatasetName: compare.name,
    baselineSnapshotId: base.snapshotId,
    comparisonSnapshotId: compare.snapshotId,
    dimensions: [...plan.dimensions],
    dimensionKeys: plan.dimensions.map(normalizeToken),
    metrics: [...plan.metrics],
    metricKeys: plan.metrics.map(normalizeToken),
    threshold: plan.threshold,
    significance: plan.significance,
    thresholdPolicy: THRESHOLD_POLICY,
    configSignature: configSignature(plan),
    items,
    summary,
    scan: {
      fullScan,
      scannedSlices,
      reusedSlices,
      recomputedSlices,
      sourceReportId: structuralChange ? null : prior?.id ?? null,
      reusedSignificance: !structuralChange && !significanceChanged,
      criticalBand: {
        lowRatio: CRITICAL_BAND_LOW_RATIO,
        highRatio: CRITICAL_BAND_HIGH_RATIO,
      },
    },
  }

  // 同一方案下新的候选会替代更早的候选，但绝不覆盖已发布报告。
  let nextReports = allReports
  if (report.state === 'candidate') {
    nextReports = nextReports.map((item) => {
      if (item.planId !== plan.id || item.state !== 'candidate' || item.supersededAt) return item
      return { ...item, supersededAt: timestamp }
    })
  }
  nextReports = [...nextReports, report]
  saveReports(nextReports)

  const message = fullScan
    ? `已全量重算：${describeReason(reason)}，扫描 ${scannedSlices} 个维度切片，生成${report.state === 'published' ? '已发布' : '候选'}报告 v${version}`
    : `已复用 ${reusedSlices} 个未变化切片，仅重算 ${recomputedSlices} 个临界/翻转切片，生成${report.state === 'published' ? '已发布' : '候选'}报告 v${version}（${describeReason(reason)}）`

  return {
    ok: true,
    message,
    report,
    reusedFrom: structuralChange ? null : prior?.id ?? null,
    detail: {
      reason,
      fullScan,
      scannedSlices,
      reusedSlices,
      recomputedSlices,
      itemCount: summary.itemCount,
      unclassifiedCount: summary.unclassifiedCount,
    },
  }
}

/** 发布候选报告；已停用方案只能保留候选。旧发布报告仍可下钻。 */
export function publishComparisonReport(reportId: string): { ok: boolean; message: string; report: ComparisonReport | null } {
  const allReports = reports()
  const target = allReports.find((item) => item.id === reportId)
  if (!target) {
    return { ok: false, message: `没有找到报告 ${reportId}`, report: null }
  }
  if (target.state === 'candidate' && target.supersededAt) {
    return { ok: false, message: `候选报告 v${target.version} 已被更新的候选替代，请发布最新候选`, report: null }
  }
  if (target.state === 'published') {
    return { ok: false, message: `报告 v${target.version} 已经是已发布状态，无需重复发布`, report: null }
  }
  if (target.state === 'revoked') {
    return { ok: false, message: '报告已撤销，不能再次发布，请重新生成', report: null }
  }
  const plan = planById(target.planId)
  if (!plan) {
    return { ok: false, message: `没有找到对比方案 ${target.planId}`, report: null }
  }
  if (plan.disabled) {
    return { ok: false, message: '对比方案已停用，新阈值修改只能生成候选报告，不能发布', report: null }
  }
  const timestamp = nowIso()
  const next = allReports.map((item) => {
    if (item.planId !== target.planId || item.id === target.id) return item
    if (item.state === 'published') {
      return { ...item, supersededAt: item.supersededAt ?? timestamp }
    }
    return item
  })
  const updated: ComparisonReport = {
    ...target,
    state: 'published',
    publishedAt: timestamp,
  } as ComparisonReport
  const replaced = next.map((item) => (item.id === target.id ? updated : item))
  saveReports(replaced)
  return { ok: true, message: `报告 v${target.version} 已发布，原发布版本继续可读`, report: updated }
}

/** 撤销发布：明细留在报告里，仍可下钻。 */
export function revokeComparisonReport(reportId: string): { ok: boolean; message: string; report: ComparisonReport | null } {
  const allReports = reports()
  const target = allReports.find((item) => item.id === reportId)
  if (!target) {
    return { ok: false, message: `没有找到报告 ${reportId}`, report: null }
  }
  if (target.state !== 'published') {
    return { ok: false, message: '只有已发布报告可以撤销', report: null }
  }
  const timestamp = nowIso()
  const updated: ComparisonReport = {
    ...target,
    state: 'revoked',
    revokedAt: timestamp,
  }
  saveReports(allReports.map((item) => (item.id === target.id ? updated : item)))
  return {
    ok: true,
    message: `报告 v${target.version} 已撤销；差异明细保留，仍可下钻，并可核对基准快照 ${target.baselineSnapshotId}`,
    report: updated,
  }
}

/** 修改方案配置：实质性变更自动生成候选；仅顺序/大小写差异不产生新判定版本。 */
export function updateComparisonPlan(
  planId: number,
  patch: { threshold?: number; significance?: number; dimensionsRaw?: string; metricsRaw?: string },
): UpdatePlanResult {
  const current = planById(planId)
  if (!current) {
    return { ok: false, message: `没有找到对比方案 ${planId}`, plan: null, generated: null, cosmeticOnly: false }
  }
  const next: ComparisonPlan = { ...current }
  if (patch.threshold !== undefined) {
    if (!Number.isFinite(patch.threshold) || patch.threshold < 0) {
      return { ok: false, message: '差异阈值必须是不小于 0 的数值（口径为相对差异百分比）', plan: null, generated: null, cosmeticOnly: false }
    }
    next.threshold = Number(patch.threshold.toFixed(6))
  }
  if (patch.significance !== undefined) {
    if (!Number.isFinite(patch.significance) || patch.significance <= 0 || patch.significance >= 0.5) {
      return { ok: false, message: '显著性水平必须在 0 到 0.5 之间', plan: null, generated: null, cosmeticOnly: false }
    }
    next.significance = Number(patch.significance.toFixed(6))
  }
  if (patch.dimensionsRaw !== undefined) {
    const parsed = parseFieldList(patch.dimensionsRaw)
    if (parsed.length === 0) {
      return { ok: false, message: '对比维度不能为空', plan: null, generated: null, cosmeticOnly: false }
    }
    try {
      const base = safeDataset(next.baseDatasetId)
      next.dimensions = resolveColumns(base, parsed)
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '对比维度解析失败', plan: null, generated: null, cosmeticOnly: false }
    }
    next.rawDimensions = next.dimensions.join(', ')
  }
  if (patch.metricsRaw !== undefined) {
    const parsed = parseFieldList(patch.metricsRaw)
    if (parsed.length === 0) {
      return { ok: false, message: '对比指标不能为空', plan: null, generated: null, cosmeticOnly: false }
    }
    try {
      const base = safeDataset(next.baseDatasetId)
      next.metrics = resolveColumns(base, parsed)
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '对比指标解析失败', plan: null, generated: null, cosmeticOnly: false }
    }
    next.rawMetrics = next.metrics.join(', ')
  }

  const before = configSignature(current)
  const after = configSignature(next)
  // 维度顺序、大小写、分隔符属于展示口径：业务字段集合没变就不产生新判定版本。
  const fieldsSame =
    sameFieldSet(next.dimensions, current.dimensions) && sameFieldSet(next.metrics, current.metrics)
  const orderChanged = !sameOrder(next.dimensions, current.dimensions) || !sameOrder(next.metrics, current.metrics)
  const cosmeticOnly =
    fieldsSame &&
    orderChanged &&
    next.threshold === current.threshold &&
    next.significance === current.significance
  savePlan(next)
  syncPlanEntry(next)

  if (cosmeticOnly) {
    // 顺序与大小写只影响展示口径：旧报告继续用自己的层级顺序，引用关系不变。
    // 下次因阈值/显著性生成报告时会按新顺序重建层级，明细键与业务口径无关，不会出现虚假新增。
    return {
      ok: true,
      message: '仅对比维度顺序/大小写规范化，未产生新的判定版本；已有报告与差异明细保持不变',
      plan: next,
      generated: null,
      cosmeticOnly: true,
    }
  }
  if (before === after) {
    return {
      ok: true,
      message: '配置未发生实质性变化，已有报告继续引用原判定',
      plan: next,
      generated: null,
      cosmeticOnly: false,
    }
  }

  const hasReports = reports().some((report) => report.planId === planId)
  if (!hasReports) {
    return {
      ok: true,
      message: '方案配置已保存；首次生成报告时会按新配置建立判定',
      plan: next,
      generated: null,
      cosmeticOnly: false,
    }
  }

  const generated = generateComparisonReport(planId)
  return {
    ok: generated.ok,
    message: generated.ok
      ? `${generated.message}${next.disabled ? '；方案已停用，只保留候选报告' : ''}`
      : generated.message,
    plan: next,
    generated: generated.report,
    cosmeticOnly: false,
  }
}

/** 停用/启用方案；停用后旧报告仍可下钻，新修改只能形成候选。 */
export function setComparisonPlanEnabled(planId: number, enabled: boolean): { ok: boolean; message: string; plan: ComparisonPlan | null } {
  const current = planById(planId)
  if (!current) {
    return { ok: false, message: `没有找到对比方案 ${planId}`, plan: null }
  }
  const next: ComparisonPlan = {
    ...current,
    disabled: !enabled,
    status: enabled ? '已启用' : '已停用',
  }
  savePlan(next)
  syncPlanEntry(next)
  return {
    ok: true,
    message: enabled
      ? `对比方案 ${current.code} 已启用，可发布新的候选报告`
      : `对比方案 ${current.code} 已停用；旧报告仍可下钻，新的阈值修改只能生成候选`,
    plan: next,
  }
}

/** 把方案状态/阈值同步到对比分析清单，保持两个视图口径一致。 */
function syncPlanEntry(plan: ComparisonPlan): void {
  const rows = listRows('compare')
  const index = rows.findIndex((row) => Number(row.id) === plan.id)
  if (index < 0) return
  const updated = {
    ...rows[index],
    status: plan.disabled ? '已停用' : plan.status === '待校验' ? '待校验' : plan.status,
    pending: plan.disabled ? false : rows[index].pending,
    对比维度: plan.dimensions.join(', '),
    对比指标: plan.metrics.join(', '),
    差异阈值: String(plan.threshold),
    显著性水平: String(plan.significance),
  }
  const next = [...rows]
  next[index] = updated
  saveRows('compare', next)
}

/**
 * 首次打开对比分析页时补一份示例报告，让“月末只调阈值”的流程可以直接复现：
 * 已启用方案 1 会生成并自动发布 v1，后续调阈值只会产生 v2 候选。
 */
export function ensureInitialComparisonReport(): ComparisonReport | null {
  if (reports().length > 0) return null
  const result = generateComparisonReport(1)
  return result.ok ? result.report : null
}

/** 页面初始化时读取数据集清单（只读）。 */
export function comparisonDatasets(): ComparisonDataset[] {
  return datasets()
}

export function planSnapshots(): PlanSnapshot[] {
  const allReports = reports()
  return plans().map((plan) => {
    const planReports = allReports.filter((report) => report.planId === plan.id)
    const published = publishedReportForPlan(allReports, plan.id)
    const candidates = planReports.filter((report) => report.state === 'candidate' && !report.supersededAt)
    const latest = planReports.length > 0 ? [...planReports].sort((a, b) => b.version - a.version)[0] : null
    return {
      plan,
      published,
      candidate: candidates.length > 0 ? [...candidates].sort((a, b) => b.version - a.version)[0] : null,
      latest,
      versionCount: planReports.length,
    }
  })
}

export function listComparisonReports(planId?: number): ComparisonReport[] {
  const all = planId === undefined ? reports() : reports().filter((report) => report.planId === planId)
  return [...all].sort((a, b) => {
    if (a.planId !== b.planId) return a.planId - b.planId
    return a.version - b.version
  })
}

export function reportById(reportId: string): ComparisonReport | null {
  return reports().find((report) => report.id === reportId) ?? null
}

/**
 * 当前展示口径：当前已发布版本 → 最新候选 → 仍有明细的历史发布版本 → 最新版本。
 * 候选不会挤掉已发布报告；撤销当前发布后也能回落到上一份可读的发布版本。
 */
export function currentReportForPlan(planId: number): ComparisonReport | null {
  const all = reports().filter((report) => report.planId === planId)
  if (all.length === 0) return null
  const published = publishedReportForPlan(all, planId)
  if (published) return published
  const candidates = all
    .filter((report) => report.state === 'candidate' && !report.supersededAt)
    .sort((a, b) => b.version - a.version)
  if (candidates.length > 0) return candidates[0]
  const historicalPublished = all
    .filter((report) => report.state === 'published')
    .sort((a, b) => b.version - a.version)
  if (historicalPublished.length > 0) return historicalPublished[0]
  return all.sort((a, b) => b.version - a.version)[0]
}

/** 下钻已有报告；报告属于已停用方案或已撤销也照常下钻。 */
export function drillComparisonReport(
  reportId: string,
  level: number,
  parentItemKey: string | null = null,
): { ok: boolean; message: string; result: DrillResult | null } {
  const report = reportById(reportId)
  if (!report) {
    return { ok: false, message: `没有找到报告 ${reportId}`, result: null }
  }
  if (!Array.isArray(report.items) || !Array.isArray(report.dimensions)) {
    return {
      ok: false,
      message: `报告 v${report.version ?? '?'} 缺少差异明细字段，请先执行「清理异常明细」修复`,
      result: null,
    }
  }
  let result: DrillResult
  try {
    result = drillFromReport(report, level, parentItemKey)
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? `下钻失败：${error.message}` : '下钻失败',
      result: null,
    }
  }
  return {
    ok: true,
    message: result.notice || `已定位到第 ${result.level + 1} 层维度「${result.nextDimension ?? '未定义'}」`,
    result,
  }
}

export type DataHealth = {
  ok: boolean
  duplicateItems: number
  staleItems: number
  missingFields: number
  publishedConflicts: number
  issues: string[]
}

/** 只读体检：页面启动时用来提示“显示成旧版/重复显示”的具体位置，不修改数据。 */
export function inspectCompareWorkspace(): DataHealth {
  const all = reports()
  let duplicateItems = 0
  let staleItems = 0
  let missingFields = 0
  let publishedConflicts = 0
  const issues: string[] = []
  const publishedByPlan = new Map<number, number>()
  for (const report of all) {
    if (!report.dimensionKeys || !report.metricKeys) missingFields += 1
    if (!report.scan || !report.summary) missingFields += 1
    if (!Array.isArray(report.items)) {
      missingFields += 1
      continue
    }
    if (!Array.isArray(report.dimensions) || report.dimensions.length === 0) missingFields += 1
    if (!Array.isArray(report.metrics) || report.metrics.length === 0) missingFields += 1
    const keys = new Set<string>()
    for (const item of report.items ?? []) {
      if (keys.has(item.key)) duplicateItems += 1
      keys.add(item.key)
      if (
        item.evaluatedThreshold === undefined ||
        item.evaluatedSignificance === undefined ||
        !item.dimensionKeys ||
        item.evaluatedThreshold !== report.threshold ||
        item.evaluatedSignificance !== report.significance
      ) {
        staleItems += 1
      }
    }
    if (report.state === 'published' && !report.supersededAt) {
      publishedByPlan.set(report.planId, (publishedByPlan.get(report.planId) ?? 0) + 1)
    }
  }
  for (const [planId, count] of publishedByPlan) {
    if (count > 1) {
      publishedConflicts += count - 1
      issues.push(`对比方案 #${planId} 同时存在 ${count} 份当前已发布报告，展示口径会不稳定`)
    }
  }
  if (duplicateItems > 0) issues.push(`发现 ${duplicateItems} 条重复差异明细，会重复显示`)
  if (staleItems > 0) issues.push(`发现 ${staleItems} 条残留旧阈值/旧显著性判定，可能显示成旧版`)
  if (missingFields > 0) issues.push(`发现 ${missingFields} 处报告字段缺失，读取时可能报错`)
  return {
    ok: issues.length === 0,
    duplicateItems,
    staleItems,
    missingFields,
    publishedConflicts,
    issues,
  }
}

export type CleanupSummary = {
  ok: boolean
  reportCount: number
  reportsFixed: number
  duplicateItemsRemoved: number
  staleItemsRemoved: number
  missingFieldsFixed: number
  publishedConflicts: number
  issues: string[]
  message: string
}

/** 清理故障：重复明细、残留旧阈值明细、缺失字段、同方案多份已发布报告。 */
export function auditCompareWorkspace(): CleanupSummary {
  const all = reports()
  let reportsFixed = 0
  let duplicateItemsRemoved = 0
  let staleItemsRemoved = 0
  let missingFieldsFixed = 0
  const issues: string[] = []

  const normalized = all.map((report) => {
    let changed = false
    const dimensions = Array.isArray(report.dimensions) ? report.dimensions : []
    const metrics = Array.isArray(report.metrics) ? report.metrics : []
    const dimKeys = report.dimensionKeys?.length ? report.dimensionKeys : dimensions.map(normalizeToken)
    const metricKeys = report.metricKeys?.length ? report.metricKeys : metrics.map(normalizeToken)
    if (!Array.isArray(report.dimensions) || !Array.isArray(report.metrics)) {
      changed = true
      missingFieldsFixed += 1
    }
    if (!report.dimensionKeys || !report.metricKeys) {
      changed = true
      missingFieldsFixed += 1
    }
    // 修复明细自身的字段：旧版本可能缺 key / hierarchyKey / 证据数组，读取时会抛错。
    const repairedItems = (Array.isArray(report.items) ? report.items : []).map((item) => {
      const repaired: typeof item = { ...item }
      let itemChanged = false
      if (!repaired.key) {
        repaired.key = `${repaired.hierarchyKey ?? hierarchyKeyOf(repaired.dimensionValueKeys ?? [])}\u0002${repaired.metricKey ?? normalizeToken(repaired.metric ?? '')}`
        itemChanged = true
      }
      if (!repaired.hierarchyKey) {
        repaired.hierarchyKey = hierarchyKeyOf(repaired.dimensionValueKeys ?? [])
        itemChanged = true
      }
      if (repaired.parentHierarchyKey === undefined) {
        repaired.parentHierarchyKey = parentHierarchyKeyOf(repaired.dimensionValueKeys ?? [])
        itemChanged = true
      }
      if (!Array.isArray(repaired.evidence)) {
        repaired.evidence = []
        itemChanged = true
      }
      if (!Array.isArray(repaired.dimensionKeys) || repaired.dimensionKeys.length === 0) {
        repaired.dimensionKeys = (repaired.dimensionLabels ?? []).map(normalizeToken)
        itemChanged = true
      }
      if (repaired.dataReused === undefined) {
        repaired.dataReused = false
        itemChanged = true
      }
      if (repaired.judgmentRecomputed === undefined) {
        repaired.judgmentRecomputed = false
        itemChanged = true
      }
      if (repaired.thresholdExceeded === undefined) {
        repaired.thresholdExceeded = null
        itemChanged = true
      }
      if (repaired.significant === undefined) {
        repaired.significant = null
        itemChanged = true
      }
      if (itemChanged) {
        missingFieldsFixed += 1
        changed = true
      }
      return repaired
    })
    const valid = repairedItems.filter((item) => {
      const inDimensions = item.dimensionKeys.every((key) => dimKeys.includes(key))
      const inMetrics = metricKeys.includes(item.metricKey)
      const thresholdAligned = item.evaluatedThreshold === report.threshold
      const significanceAligned = item.evaluatedSignificance === report.significance
      const levelSane = item.level >= 0 && item.level < Math.max(1, dimensions.length)
      return inDimensions && inMetrics && thresholdAligned && significanceAligned && levelSane
    })
    const staleCount = repairedItems.length - valid.length
    if (staleCount > 0) {
      staleItemsRemoved += staleCount
      changed = true
      issues.push(`报告 v${report.version} 清理 ${staleCount} 条残留旧阈值/旧维度明细`)
    }
    const deduped = dedupeItems(valid)
    const dupCount = valid.length - deduped.length
    if (dupCount > 0) {
      duplicateItemsRemoved += dupCount
      changed = true
      issues.push(`报告 v${report.version} 去重 ${dupCount} 条重复明细`)
    }
    const summary = summarize(deduped)
    const summaryChanged = JSON.stringify(summary) !== JSON.stringify(report.summary)
    if (summaryChanged) {
      changed = true
      missingFieldsFixed += report.summary ? 0 : 1
    }
    const scan = report.scan ?? {
      fullScan: true,
      scannedSlices: summary.sliceCount,
      reusedSlices: 0,
      recomputedSlices: summary.sliceCount,
      sourceReportId: null,
      reusedSignificance: true,
      criticalBand: { lowRatio: CRITICAL_BAND_LOW_RATIO, highRatio: CRITICAL_BAND_HIGH_RATIO },
    }
    if (!report.scan) {
      missingFieldsFixed += 1
    }
    if (changed) {
      reportsFixed += 1
    }
    return {
      ...report,
      dimensions,
      metrics,
      dimensionKeys: dimKeys,
      metricKeys,
      items: deduped,
      summary,
      scan,
    }
  })

  // 同一方案只允许一份当前已发布报告：保留版本最高的，其余标记为被替代但仍可下钻。
  const grouped = new Map<number, ComparisonReport[]>()
  for (const report of normalized) {
    // 历史上被替代的发布版本是正常留档，不参与“多份当前发布”冲突判定。
    if (report.state !== 'published' || report.supersededAt) continue
    const list = grouped.get(report.planId) ?? []
    list.push(report)
    grouped.set(report.planId, list)
  }
  let final = normalized
  let conflictCount = 0
  for (const [, list] of grouped) {
    if (list.length <= 1) continue
    const keep = [...list].sort((a, b) => b.version - a.version)[0]
    conflictCount += list.length - 1
    issues.push(`对比方案 ${keep.planCode} 存在 ${list.length} 份已发布报告，保留 v${keep.version}，其余标记为历史版本`)
    final = final.map((report) => {
      if (report.state !== 'published' || report.planId !== keep.planId || report.id === keep.id) return report
      if (report.supersededAt) return report
      reportsFixed += 1
      return { ...report, supersededAt: keep.publishedAt ?? keep.createdAt }
    })
  }

  if (reportsFixed > 0) {
    saveReports(final)
  }

  const message =
    reportsFixed === 0 && issues.length === 0
      ? `已检查 ${all.length} 份报告，未发现重复明细或残留旧判定`
      : `已检查 ${all.length} 份报告：修复 ${reportsFixed} 份，去重 ${duplicateItemsRemoved} 条，清理残留 ${staleItemsRemoved} 条`

  return {
    ok: true,
    reportCount: all.length,
    reportsFixed,
    duplicateItemsRemoved,
    staleItemsRemoved,
    missingFieldsFixed,
    publishedConflicts: conflictCount,
    issues,
    message,
  }
}
