/** 对比分析领域模型：数据集快照、对比方案、判定报告与差异明细。 */

export type DatasetColumnType = 'string' | 'number'

export type DatasetColumn = {
  name: string
  type: DatasetColumnType
}

export type DatasetCell = string | number | null

export type ComparisonDataset = {
  id: string
  name: string
  sourceLabel: string
  /** 快照编号：报告生成时写入，撤销后重新生成也能追溯用了哪一次基准快照。 */
  snapshotId: string
  capturedAt: string
  columns: DatasetColumn[]
  rows: Record<string, DatasetCell>[]
}

export type ComparisonPlan = {
  id: number
  code: string
  baseDatasetId: string
  compareDatasetId: string
  /** 配置原文，可能带顺序、大小写、空格差异，进入引擎后统一规范化。 */
  rawDimensions: string
  rawMetrics: string
  dimensions: string[]
  metrics: string[]
  threshold: number
  significance: number
  outputMode: string
  status: string
  disabled: boolean
}

export type Judgment = 'significant' | 'threshold-only' | 'within-threshold' | 'unclassified'

export type ComparisonItem = {
  /** 稳定键：层级 + 规范化维度值 + 指标，重复执行不会产生重复明细。 */
  key: string
  /** 当前方案维度顺序下的层级键，用于下钻时按前缀归组。 */
  hierarchyKey: string
  parentHierarchyKey: string | null
  level: number
  dimensionKeys: string[]
  dimensionLabels: string[]
  dimensionValueKeys: string[]
  dimensionValues: string[]
  metric: string
  metricKey: string
  baseValue: number | null
  compareValue: number | null
  diff: number | null
  relativeDiff: number | null
  baseCount: number
  compareCount: number
  zScore: number | null
  thresholdExceeded: boolean | null
  significant: boolean | null
  judgment: Judgment
  missingSide: 'base' | 'compare' | null
  unclassified: boolean
  unclassifiedReason: string
  fingerprint: string
  dataFingerprint: string
  dataReused: boolean
  judgmentRecomputed: boolean
  reusedFromReportId: string | null
  /** 这条明细当时是按哪个阈值/显著性水平判定的，发布后不再改写。 */
  evaluatedThreshold: number
  evaluatedSignificance: number
  evidence: string[]
}

export type ReportSummary = {
  itemCount: number
  sliceCount: number
  differenceCount: number
  evidenceCount: number
  significantCount: number
  unclassifiedCount: number
  reusedCount: number
  recomputedCount: number
}

export type ReportReason =
  | 'initial'
  | 'manual'
  | 'threshold'
  | 'significance'
  | 'threshold+significance'
  | 'dimensions'
  | 'metrics'
  | 'snapshot'
  | 'config'

export type ComparisonReportState = 'candidate' | 'published' | 'revoked'

export type ReportScan = {
  /** 维度切片是否全量重扫。只调阈值时为 false，其余配置变更才全量。 */
  fullScan: boolean
  scannedSlices: number
  reusedSlices: number
  recomputedSlices: number
  /** 复用数据与判定的来源报告（通常是上一次已发布报告）。 */
  sourceReportId: string | null
  reusedSignificance: boolean
  /** 阈值口径：相对差异百分比；临界带为 [阈值*0.8, 阈值*1.2]。 */
  criticalBand: { lowRatio: number; highRatio: number }
}

export type ComparisonReport = {
  id: string
  planId: number
  planCode: string
  version: number
  state: ComparisonReportState
  reason: ReportReason
  parentReportId: string | null
  createdAt: string
  publishedAt: string | null
  revokedAt: string | null
  supersededAt: string | null
  baseDatasetId: string
  compareDatasetId: string
  baseDatasetName: string
  compareDatasetName: string
  /** 生成这份报告时两侧数据集的快照编号。 */
  baselineSnapshotId: string
  comparisonSnapshotId: string
  dimensions: string[]
  dimensionKeys: string[]
  metrics: string[]
  metricKeys: string[]
  threshold: number
  significance: number
  thresholdPolicy: 'relative-percent'
  configSignature: string
  items: ComparisonItem[]
  summary: ReportSummary
  scan: ReportScan
}

export type CompareWorkspaceState = {
  version: 1
  reports: ComparisonReport[]
  plans: ComparisonPlan[]
}

export type CleanupResult = {
  ok: boolean
  reportCount: number
  reportsFixed: number
  duplicateItemsRemoved: number
  staleItemsRemoved: number
  missingFieldsFixed: number
  issues: string[]
  message: string
}

export type DrillResult = {
  report: ComparisonReport
  requestedLevel: number
  level: number
  missingDimension: boolean
  parentItemKey: string | null
  parentValues: string[]
  nextDimension: string | null
  nextDimensionKey: string | null
  items: ComparisonItem[]
  unclassifiedItems: ComparisonItem[]
  /** 下钻维度在报告快照中缺失时，把最近一层结论按未归类行列出，不重算。 */
  missingDimensionRows: ComparisonItem[]
  notice: string
  /** 明细来自哪一次基准快照，撤销后重新生成也能核对。 */
  baselineSnapshotId: string
  comparisonSnapshotId: string
  reportState: ComparisonReportState
  reportVersion: number
}
