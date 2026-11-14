import type {
  ComparisonDataset,
  ComparisonItem,
  ComparisonPlan,
  ComparisonReport,
  ComparisonReportState,
  DrillResult,
  Judgment,
  ReportReason,
  ReportSummary,
} from './compare-types'

/** 对比口径统一在这里定义，页面与数据层都只认这套规则。 */

/** 差异阈值口径：相对差值百分比 |对照 - 基准| / |基准| * 100，与阈值直接比较。 */
export const THRESHOLD_POLICY = 'relative-percent' as const

/** 临界带：以阈值为中心上下各 20% 的区间，落在带内的切片必须重新判定。 */
export const CRITICAL_BAND_LOW_RATIO = 0.8
export const CRITICAL_BAND_HIGH_RATIO = 1.2

export function normalizeToken(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_\-]+/g, '')
}

export function dedupeNames(values: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const key = normalizeToken(value)
    if (!key || seen.has(key)) continue
    seen.add(key)
    result.push(value.trim())
  }
  return result
}

export function parseFieldList(raw: string): string[] {
  return dedupeNames(raw.split(/[,，;；|]/))
}

export function canonicalFieldSignature(values: string[]): string {
  return dedupeNames(values)
    .map(normalizeToken)
    .sort()
    .join('|')
}

export function configSignature(plan: ComparisonPlan): string {
  return [
    plan.baseDatasetId,
    plan.compareDatasetId,
    canonicalFieldSignature(plan.dimensions),
    canonicalFieldSignature(plan.metrics),
    plan.threshold.toFixed(4),
    plan.significance.toFixed(4),
  ].join('::')
}

export function structureSignature(plan: ComparisonPlan): string {
  return [
    plan.baseDatasetId,
    plan.compareDatasetId,
    canonicalFieldSignature(plan.dimensions),
    canonicalFieldSignature(plan.metrics),
  ].join('::')
}

export function sameFieldSet(a: string[], b: string[]): boolean {
  return canonicalFieldSignature(a) === canonicalFieldSignature(b)
}

export function sameOrder(a: string[], b: string[]): boolean {
  return a.map(normalizeToken).join('|') === b.map(normalizeToken).join('|')
}

export function resolveColumns(dataset: ComparisonDataset, names: string[]): string[] {
  return names.map((name) => {
    const key = normalizeToken(name)
    const column = dataset.columns.find((item) => normalizeToken(item.name) === key)
    if (!column) {
      throw new Error(`数据集「${dataset.name}」没有字段「${name}」`)
    }
    return column.name
  })
}

/** 同一维度在两个数据集里类型不同时阻止误比较（字符串金额 vs 数字金额）。 */
export function typeMismatch(
  base: ComparisonDataset,
  compare: ComparisonDataset,
  names: string[],
): string | null {
  for (const name of names) {
    const key = normalizeToken(name)
    const baseColumn = base.columns.find((item) => normalizeToken(item.name) === key)
    const compareColumn = compare.columns.find((item) => normalizeToken(item.name) === key)
    if (!baseColumn || !compareColumn) {
      throw new Error(`字段「${name}」在两侧数据集中没有同时存在`)
    }
    if (baseColumn.type !== compareColumn.type) {
      return `字段「${baseColumn.name}」口径不一致：基准数据集为 ${baseColumn.type}，对照数据集为 ${compareColumn.type}，已阻止对比`
    }
  }
  return null
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value.replace(/,/g, '').trim())
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

export function cellKey(value: unknown): string {
  if (value === null || value === undefined || value === '') return '\u0000missing'
  return String(value).trim().toLowerCase()
}

export function cellLabel(value: unknown): string {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

export function hierarchyKeyOf(valueKeys: string[]): string {
  return valueKeys.join('\u0001')
}

export function parentHierarchyKeyOf(valueKeys: string[]): string | null {
  if (valueKeys.length <= 1) return null
  return hierarchyKeyOf(valueKeys.slice(0, -1))
}

export function itemKeyOf(
  dimensionKeys: string[],
  dimensionValueKeys: string[],
  metricKey: string,
): string {
  const pairs = dimensionKeys
    .map((key, index) => `${key}=${dimensionValueKeys[index] ?? '\u0000missing'}`)
    .sort()
  return `${pairs.join('&')}\u0002${metricKey}`
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function variance(values: number[]): number | null {
  if (values.length < 2) return null
  const avg = mean(values) as number
  const squared = values.reduce((sum, value) => sum + (value - avg) ** 2, 0)
  return squared / (values.length - 1)
}

export function relativeDiffOf(base: number | null, compare: number | null): number | null {
  if (base === null || compare === null) return null
  if (base === 0) return compare === 0 ? 0 : null
  return Number((((compare - base) / Math.abs(base)) * 100).toFixed(6))
}

export function thresholdFlag(
  baseValue: number | null,
  compareValue: number | null,
  threshold: number,
): boolean | null {
  if (baseValue === null || compareValue === null) return null
  const relative = relativeDiffOf(baseValue, compareValue)
  if (relative !== null) return Math.abs(relative) > threshold
  // 基准为 0 时相对差异无定义：对照非 0 即视为超出阈值，并保留绝对差异作为证据。
  if (baseValue === 0) return compareValue !== 0
  return null
}

/** 双侧正态近似临界值，避免引入统计库。 */
const Z_TABLE: { alpha: number; z: number }[] = [
  { alpha: 0.2, z: 1.2816 },
  { alpha: 0.1, z: 1.6449 },
  { alpha: 0.05, z: 1.96 },
  { alpha: 0.02, z: 2.3263 },
  { alpha: 0.01, z: 2.5758 },
  { alpha: 0.005, z: 2.807 },
  { alpha: 0.001, z: 3.2905 },
]

export function zCritical(alpha: number): number {
  const clamped = Math.min(0.2, Math.max(0.001, alpha))
  for (const entry of Z_TABLE) {
    if (clamped >= entry.alpha) return entry.z
  }
  return Z_TABLE[Z_TABLE.length - 1].z
}

export function significanceFlag(zScore: number | null, alpha: number): boolean | null {
  if (zScore === null) return false
  if (!Number.isFinite(zScore)) return true
  return Math.abs(zScore) > zCritical(alpha)
}

export function inCriticalBand(relativeDiff: number | null, threshold: number): boolean {
  if (relativeDiff === null) return false
  const magnitude = Math.abs(relativeDiff)
  return (
    magnitude >= threshold * CRITICAL_BAND_LOW_RATIO &&
    magnitude <= threshold * CRITICAL_BAND_HIGH_RATIO
  )
}

export type SliceStats = {
  dimensionValueKeys: string[]
  dimensionValues: string[]
  baseCount: number
  compareCount: number
  baseValues: number[][]
  compareValues: number[][]
}

export type ScanOptions = {
  level: number
  parentValueKeys?: string[]
}

/**
 * 按 level 聚合切片。两侧各自成组，一侧没有的维度组合会保留为 missing 侧，
 * 绝不按 0 补齐。
 */
export function scanLevel(
  base: ComparisonDataset,
  compare: ComparisonDataset,
  dimensions: string[],
  metrics: string[],
  options: ScanOptions,
): SliceStats[] {
  const level = Math.max(0, Math.min(options.level, dimensions.length - 1))
  const parentValueKeys = options.parentValueKeys ?? []
  const activeBase = resolveColumns(base, dimensions).slice(0, level + 1)
  const activeCompare = resolveColumns(compare, dimensions).slice(0, level + 1)
  const metricBase = resolveColumns(base, metrics)
  const metricCompare = resolveColumns(compare, metrics)

  const buckets = new Map<string, SliceStats>()

  const collect = (
    dataset: ComparisonDataset,
    dimensionColumns: string[],
    metricColumns: string[],
    side: 'base' | 'compare',
  ) => {
    for (const row of dataset.rows) {
      const valueKeys = dimensionColumns.map((column) => cellKey(row[column]))
      if (
        parentValueKeys.length > 0 &&
        valueKeys.slice(0, parentValueKeys.length).some((key, index) => key !== parentValueKeys[index])
      ) {
        continue
      }
      const groupKey = hierarchyKeyOf(valueKeys)
      let bucket = buckets.get(groupKey)
      if (!bucket) {
        bucket = {
          dimensionValueKeys: valueKeys,
          dimensionValues: dimensionColumns.map((column) => cellLabel(row[column])),
          baseCount: 0,
          compareCount: 0,
          baseValues: metrics.map(() => []),
          compareValues: metrics.map(() => []),
        }
        buckets.set(groupKey, bucket)
      }
      if (side === 'base') {
        bucket.baseCount += 1
        metricColumns.forEach((column, index) => {
          const parsed = toNumber(row[column])
          if (parsed !== null) bucket!.baseValues[index].push(parsed)
        })
      } else {
        bucket.compareCount += 1
        metricColumns.forEach((column, index) => {
          const parsed = toNumber(row[column])
          if (parsed !== null) bucket!.compareValues[index].push(parsed)
        })
      }
    }
  }

  collect(base, activeBase, metricBase, 'base')
  collect(compare, activeCompare, metricCompare, 'compare')

  return [...buckets.values()]
}

export type BuildContext = {
  level: number
  dimensionKeys: string[]
  dimensionLabels: string[]
  metric: string
  metricKey: string
  baseDatasetName: string
  compareDatasetName: string
  threshold: number
  significance: number
}

export function buildEvidence(params: {
  missingSide: 'base' | 'compare' | null
  baseValue: number | null
  compareValue: number | null
  relativeDiff: number | null
  thresholdExceeded: boolean | null
  significant: boolean | null
  zScore: number | null
  threshold: number
  significance: number
  baseDatasetName: string
  compareDatasetName: string
  baseCount: number
  compareCount: number
}): string[] {
  const evidence: string[] = []
  if (params.missingSide === 'base') {
    evidence.push(
      `基准数据集「${params.baseDatasetName}」缺少该维度组，对照侧 ${params.compareCount} 行，未按 0 补齐`,
    )
  } else if (params.missingSide === 'compare') {
    evidence.push(
      `对照数据集「${params.compareDatasetName}」缺少该维度组，基准侧 ${params.baseCount} 行，未按 0 补齐`,
    )
  } else if (params.baseValue === null || params.compareValue === null) {
    evidence.push('指标没有有效数值，未参与判定')
  }
  if (params.thresholdExceeded) {
    if (params.relativeDiff !== null) {
      evidence.push(`相对差异 ${params.relativeDiff.toFixed(2)}% 超过阈值 ${params.threshold}%`)
    } else {
      evidence.push(`基准值为 0、对照值非 0，按绝对差异记为超出阈值 ${params.threshold}%`)
    }
  }
  if (params.significant && params.zScore !== null && Number.isFinite(params.zScore)) {
    evidence.push(
      `双侧均值差 z=${params.zScore.toFixed(2)} 超过 α=${params.significance} 的临界值 ${zCritical(params.significance).toFixed(3)}`,
    )
  }
  if (params.significant && params.zScore !== null && !Number.isFinite(params.zScore)) {
    evidence.push('两侧均值差且组内方差为 0，判定为显著')
  }
  return evidence
}

export function buildItem(stats: SliceStats, metricIndex: number, context: BuildContext): ComparisonItem {
  const baseValues = stats.baseValues[metricIndex] ?? []
  const compareValues = stats.compareValues[metricIndex] ?? []
  const baseValue = baseValues.length > 0 ? baseValues.reduce((sum, value) => sum + value, 0) : null
  const compareValue =
    compareValues.length > 0 ? compareValues.reduce((sum, value) => sum + value, 0) : null
  const baseMean = mean(baseValues)
  const compareMean = mean(compareValues)
  const baseVariance = variance(baseValues)
  const compareVariance = variance(compareValues)
  let zScore: number | null = null
  if (
    baseMean !== null &&
    compareMean !== null &&
    baseVariance !== null &&
    compareVariance !== null &&
    baseValues.length > 1 &&
    compareValues.length > 1
  ) {
    const pooled = baseVariance / baseValues.length + compareVariance / compareValues.length
    if (pooled > 0) {
      zScore = Number(((compareMean - baseMean) / Math.sqrt(pooled)).toFixed(6))
    } else {
      zScore = compareMean === baseMean ? 0 : compareMean > baseMean ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY
    }
  }

  const missingSide: 'base' | 'compare' | null =
    stats.baseCount === 0 ? 'base' : stats.compareCount === 0 ? 'compare' : null
  const relativeDiff = relativeDiffOf(baseValue, compareValue)
  const thresholdExceeded = thresholdFlag(baseValue, compareValue, context.threshold)
  const significant = missingSide ? false : significanceFlag(zScore, context.significance)
  const unclassified =
    missingSide !== null || baseValue === null || compareValue === null
  const judgment: Judgment = unclassified
    ? 'unclassified'
    : significant
      ? 'significant'
      : thresholdExceeded
        ? 'threshold-only'
        : 'within-threshold'

  const dimensionKeys = context.dimensionKeys.slice(0, stats.dimensionValueKeys.length)
  const dimensionLabels = context.dimensionLabels.slice(0, stats.dimensionValueKeys.length)
  const key = itemKeyOf(dimensionKeys, stats.dimensionValueKeys, context.metricKey)
  const evidence = buildEvidence({
    missingSide,
    baseValue,
    compareValue,
    relativeDiff,
    thresholdExceeded,
    significant,
    zScore,
    threshold: context.threshold,
    significance: context.significance,
    baseDatasetName: context.baseDatasetName,
    compareDatasetName: context.compareDatasetName,
    baseCount: stats.baseCount,
    compareCount: stats.compareCount,
  })

  return {
    key,
    hierarchyKey: hierarchyKeyOf(stats.dimensionValueKeys),
    parentHierarchyKey: parentHierarchyKeyOf(stats.dimensionValueKeys),
    level: context.level,
    dimensionKeys,
    dimensionLabels,
    dimensionValueKeys: stats.dimensionValueKeys,
    dimensionValues: stats.dimensionValues,
    metric: context.metric,
    metricKey: context.metricKey,
    baseValue,
    compareValue,
    diff:
      baseValue === null || compareValue === null ? null : Number((compareValue - baseValue).toFixed(6)),
    relativeDiff,
    baseCount: stats.baseCount,
    compareCount: stats.compareCount,
    zScore,
    thresholdExceeded,
    significant,
    judgment,
    missingSide,
    unclassified,
    unclassifiedReason:
      missingSide !== null
        ? `${missingSide === 'base' ? '基准' : '对照'}侧缺失该维度组，单列未归类行`
        : baseValue === null || compareValue === null
          ? '指标没有有效数值，单列未归类行'
          : '',
    fingerprint: `${key}=${baseValue ?? 'x'}/${compareValue ?? 'x'}`,
    dataFingerprint: `${stats.baseCount}|${stats.compareCount}|${baseValue ?? 'x'}|${compareValue ?? 'x'}|${zScore ?? 'x'}`,
    dataReused: false,
    judgmentRecomputed: false,
    reusedFromReportId: null,
    evaluatedThreshold: context.threshold,
    evaluatedSignificance: context.significance,
    evidence,
  }
}

/** 用已有明细的数据重新判定（阈值/显著性变化时避免重扫维度）。 */
export function reevaluateItem(
  source: ComparisonItem,
  params: {
    threshold: number
    significance: number
    recomputeThreshold: boolean
    recomputeSignificance: boolean
    /** 哪些切片算“重算过判定”：临界带/判定翻转/显著性变化。仅换阈值标签不计入。 */
    markRecomputed?: boolean
    sourceReportId: string
    baseDatasetName: string
    compareDatasetName: string
  },
): ComparisonItem {
  // 阈值标记基于已存下的 baseValue/compareValue 直接算，不重扫维度；
  // 但它只影响“是否重算过判定”的统计，不影响最终判定版本的冻结。
  const thresholdExceeded = params.recomputeThreshold
    ? thresholdFlag(source.baseValue, source.compareValue, params.threshold)
    : source.thresholdExceeded
  const significant = params.recomputeSignificance
    ? significanceFlag(source.zScore, params.significance)
    : source.significant
  const unclassified =
    source.missingSide !== null || source.baseValue === null || source.compareValue === null
  const judgment: Judgment = unclassified
    ? 'unclassified'
    : significant
      ? 'significant'
      : thresholdExceeded
        ? 'threshold-only'
        : 'within-threshold'
  const relativeDiff = source.relativeDiff
  const evidence = buildEvidence({
    missingSide: source.missingSide,
    baseValue: source.baseValue,
    compareValue: source.compareValue,
    relativeDiff,
    thresholdExceeded,
    significant,
    zScore: source.zScore,
    threshold: params.threshold,
    significance: params.significance,
    baseDatasetName: params.baseDatasetName,
    compareDatasetName: params.compareDatasetName,
    baseCount: source.baseCount,
    compareCount: source.compareCount,
  })
  return {
    ...source,
    thresholdExceeded,
    significant,
    judgment,
    unclassified,
    evaluatedThreshold: params.threshold,
    evaluatedSignificance: params.significance,
    evidence,
    dataReused: true,
    judgmentRecomputed:
      params.markRecomputed ?? (params.recomputeThreshold || params.recomputeSignificance),
    reusedFromReportId: params.sourceReportId,
  }
}

/** 只调阈值时，只有临界附近或判定会翻转的切片才需要重新判定。 */
export function needsThresholdRecompute(
  item: ComparisonItem,
  oldThreshold: number,
  newThreshold: number,
): boolean {
  if (item.missingSide !== null) return false
  if (item.baseValue === null || item.compareValue === null) return false
  if (item.significant === true) return false
  const relative = item.relativeDiff
  if (relative === null) return false
  const oldExceeded = item.thresholdExceeded
  const newExceeded = Math.abs(relative) > newThreshold
  if (oldExceeded !== newExceeded) return true
  return inCriticalBand(relative, oldThreshold) || inCriticalBand(relative, newThreshold)
}

export function dedupeItems(items: ComparisonItem[]): ComparisonItem[] {
  const seen = new Map<string, ComparisonItem>()
  for (const item of items) {
    const existing = seen.get(item.key)
    if (!existing) {
      seen.set(item.key, item)
      continue
    }
    // 同一 key 只保留一条：优先保留最新重算过的判定，避免重复显示。
    if (!existing.judgmentRecomputed && item.judgmentRecomputed) {
      seen.set(item.key, item)
    }
  }
  return [...seen.values()]
}

export function summarize(items: ComparisonItem[]): ReportSummary {
  const differenceCount = items.filter(
    (item) => item.judgment === 'significant' || item.judgment === 'threshold-only',
  ).length
  const unclassifiedCount = items.filter((item) => item.unclassified).length
  return {
    itemCount: items.length,
    sliceCount: new Set(items.map((item) => item.hierarchyKey)).size,
    differenceCount,
    evidenceCount: differenceCount + unclassifiedCount,
    significantCount: items.filter((item) => item.judgment === 'significant').length,
    unclassifiedCount,
    reusedCount: items.filter((item) => item.dataReused).length,
    recomputedCount: items.filter((item) => item.judgmentRecomputed).length,
  }
}

export function describeReason(reason: ReportReason): string {
  switch (reason) {
    case 'initial':
      return '首次生成'
    case 'manual':
      return '重复执行'
    case 'threshold':
      return '差异阈值变更'
    case 'significance':
      return '显著性水平变更'
    case 'threshold+significance':
      return '阈值与显著性同时变更'
    case 'dimensions':
      return '对比维度变更'
    case 'metrics':
      return '对比指标变更'
    case 'snapshot':
      return '数据快照变更'
    default:
      return '配置变更'
  }
}

export function describeState(state: ComparisonReportState): string {
  switch (state) {
    case 'published':
      return '已发布'
    case 'candidate':
      return '候选'
    case 'revoked':
      return '已撤销'
    default:
      return String(state)
  }
}

/** 下钻：只在报告已有明细上过滤，缺维度时单列未归类行，不重算旧结论。 */
export function drillReport(
  report: ComparisonReport,
  requestedLevel: number,
  parentItemKey: string | null,
): DrillResult {
  // 坏数据下钻不能把页面打崩：缺字段按空集合处理，由调用方提示清理。
  const dimensions = Array.isArray(report.dimensions) ? report.dimensions : []
  const allItems = Array.isArray(report.items) ? report.items : []
  const maxLevel = Math.max(0, dimensions.length - 1)
  const level = Math.max(0, Math.min(requestedLevel, maxLevel))
  const missingDimension = requestedLevel > maxLevel
  const parent = parentItemKey
    ? allItems.find((item) => item.key === parentItemKey) ?? null
    : null
  const targetParentHierarchy = parent ? parent.hierarchyKey : null
  const pool = allItems.filter((item) => item.level === level)
  const items = missingDimension
    ? []
    : pool.filter((item) =>
        targetParentHierarchy === null
          ? item.parentHierarchyKey === null
          : item.parentHierarchyKey === targetParentHierarchy,
      )
  const unclassifiedItems = items.filter((item) => item.unclassified)
  // 维度缺失时，最近一层已有结论整体按未归类展示：只换视图，不重算，也不改写判定。
  const missingDimensionRows = missingDimension
    ? dedupeItems(allItems.filter((item) => item.level === maxLevel))
    : []
  const nextDimension = missingDimension ? null : dimensions[level] ?? null
  const notice = missingDimension
    ? `下钻维度「第 ${requestedLevel + 1} 层」在报告快照中不存在，最近一层结论按未归类行展示，不重算旧结论`
    : nextDimension === null
      ? '当前报告没有更多下钻维度'
      : items.length === 0
        ? `维度「${nextDimension}」没有可下钻的明细，保留未归类行`
        : ''
  return {
    report,
    requestedLevel,
    level,
    missingDimension,
    parentItemKey: parent?.key ?? null,
    parentValues: parent?.dimensionValues ?? [],
    nextDimension,
    nextDimensionKey: nextDimension ? normalizeToken(nextDimension) : null,
    items: dedupeItems(items),
    unclassifiedItems: dedupeItems(unclassifiedItems),
    missingDimensionRows,
    notice,
    baselineSnapshotId: report.baselineSnapshotId,
    comparisonSnapshotId: report.comparisonSnapshotId,
    reportState: report.state,
    reportVersion: report.version,
  }
}

export function latestReportForPlan(reports: ComparisonReport[], planId: number): ComparisonReport | null {
  const candidates = reports.filter((report) => report.planId === planId)
  if (candidates.length === 0) return null
  return [...candidates].sort((a, b) => b.version - a.version)[0]
}

export function publishedReportForPlan(
  reports: ComparisonReport[],
  planId: number,
): ComparisonReport | null {
  const candidates = reports.filter((report) => report.planId === planId && report.state === 'published')
  if (candidates.length === 0) return null
  // 当前发布版本优先取未被标记为“历史版本”的最新一份，其次才是版本号最大的历史发布。
  const active = candidates.filter((report) => !report.supersededAt)
  const pool = active.length > 0 ? active : candidates
  return [...pool].sort((a, b) => b.version - a.version)[0]
}
