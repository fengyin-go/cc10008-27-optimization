import { useCallback, useEffect, useMemo, useState } from 'react'

import { downloadEntries, listEntries, moduleMeta } from '@/api/local-service'
import {
  auditCompareWorkspace,
  comparisonDatasets,
  currentReportForPlan,
  drillComparisonReport,
  ensureInitialComparisonReport,
  generateComparisonReport,
  inspectCompareWorkspace,
  listComparisonReports,
  planSnapshots,
  publishComparisonReport,
  revokeComparisonReport,
  setComparisonPlanEnabled,
  updateComparisonPlan,
  type PlanSnapshot,
} from '@/data/compare-service'
import {
  describeReason,
  describeState,
  THRESHOLD_POLICY,
} from '@/data/compare-engine'
import type { ComparisonReport, DrillResult } from '@/data/compare-types'
import type { EntryRow } from '@/data/types'
import { CompareDrillPanel } from './components/CompareDrillPanel'

const meta = moduleMeta('compare')
const columns = ['方案编号', '基准数据集', '对照数据集', '对比维度', '对比指标', '差异阈值', '显著性水平', '输出展示']

type Notice = { kind: 'ok' | 'error'; text: string }

export default function CompareView() {
  const [snapshots, setSnapshots] = useState<PlanSnapshot[]>([])
  const [reports, setReports] = useState<ComparisonReport[]>([])
  const [selectedPlanId, setSelectedPlanId] = useState<number>(1)
  const [selectedReportId, setSelectedReportId] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [auditLines, setAuditLines] = useState<string[]>([])
  const [thresholdDraft, setThresholdDraft] = useState('')
  const [significanceDraft, setSignificanceDraft] = useState('')
  const [dimensionsDraft, setDimensionsDraft] = useState('')
  const [metricsDraft, setMetricsDraft] = useState('')
  const [entryRows, setEntryRows] = useState<EntryRow[]>([])

  const refresh = useCallback((preferredReportId?: string | null) => {
    try {
      const nextSnapshots = planSnapshots()
      const nextReports = listComparisonReports()
      setEntryRows(listEntries(meta.key).items)
      setSnapshots(nextSnapshots)
      setReports(nextReports)
      const activePlan = nextSnapshots.find((item) => item.plan.id === selectedPlanId) ?? nextSnapshots[0]
      if (activePlan && activePlan.plan.id !== selectedPlanId) {
        setSelectedPlanId(activePlan.plan.id)
      }
      const fallback = activePlan ? currentReportForPlan(activePlan.plan.id) : null
      const candidateId =
        preferredReportId && nextReports.some((item) => item.id === preferredReportId)
          ? preferredReportId
          : fallback?.id ?? nextReports[nextReports.length - 1]?.id ?? null
      setSelectedReportId(candidateId)
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : '对比分析数据读取失败' })
    }
  }, [selectedPlanId])

  useEffect(() => {
    // 首次进入且没有任何报告时，用示例方案生成一份初始报告并自动发布；
    // 之后的阈值调整都会落成候选，方便直接复现“月末只调阈值”的流程。
    ensureInitialComparisonReport()
    // 启动时先做只读体检并展示定位信息：重复明细、残留旧阈值判定、缺失字段会让页面
    // 报错或显示成旧版，用户可据此一键清理，而不是被静默改写。
    const health = inspectCompareWorkspace()
    refresh()
    if (!health.ok) {
      setNotice({
        kind: 'error',
        text: `检测到本地对比数据异常：${health.duplicateItems} 条重复明细、${health.staleItems} 条残留旧判定。请点击「清理异常明细」修复。`,
      })
      setAuditLines(health.issues)
    }
    // 只在首次挂载时读一次本地数据，之后由动作触发刷新。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const selectedSnapshot = useMemo(
    () => snapshots.find((item) => item.plan.id === selectedPlanId) ?? snapshots[0] ?? null,
    [snapshots, selectedPlanId],
  )
  const selectedPlan = selectedSnapshot?.plan ?? null
  const planReports = useMemo(
    () => reports.filter((report) => report.planId === selectedPlanId).sort((a, b) => b.version - a.version),
    [reports, selectedPlanId],
  )
  const selectedReport = useMemo(
    () =>
      reports.find((report) => report.id === selectedReportId && report.planId === selectedPlanId) ??
      currentReportForPlan(selectedPlanId),
    [reports, selectedReportId, selectedPlanId],
  )

  useEffect(() => {
    if (!selectedPlan) return
    setThresholdDraft(String(selectedPlan.threshold))
    setSignificanceDraft(String(selectedPlan.significance))
    setDimensionsDraft(selectedPlan.dimensions.join(', '))
    setMetricsDraft(selectedPlan.metrics.join(', '))
  }, [selectedPlan])

  const datasets = useMemo(() => comparisonDatasets(), [])
  const datasetName = useCallback(
    (id: string) => datasets.find((item) => item.id === id)?.name ?? id,
    [datasets],
  )

  const stats = useMemo(() => {
    const openPlans = snapshots.filter((item) => !item.plan.disabled)
    // 只统计当前口径：历史版本与已被替代的候选不重复计数。
    const current = snapshots
      .map((snapshot) => (snapshot.published ?? snapshot.candidate ?? snapshot.latest))
      .filter((report): report is ComparisonReport => report !== null)
    const published = current.filter((report) => report.state === 'published')
    const candidates = current.filter((report) => report.state === 'candidate')
    const unclassified = current.reduce((sum, report) => sum + (report.summary?.unclassifiedCount ?? 0), 0)
    return [
      { label: '对比方案总数', value: snapshots.length },
      { label: '可发布方案', value: openPlans.length },
      { label: '当前发布报告', value: published.length },
      { label: '待发布候选', value: candidates.length },
      { label: '未归类证据行', value: unclassified },
    ]
  }, [snapshots])

  function withNotice(kind: Notice['kind'], text: string, preferredReportId?: string | null) {
    setNotice({ kind, text })
    refresh(preferredReportId)
  }

  function selectPlan(planId: number) {
    setSelectedPlanId(planId)
    const snapshot = snapshots.find((item) => item.plan.id === planId)
    // 默认看已发布版本：候选不能把旧发布报告挤掉当前展示口径。
    const preferred = snapshot?.published?.id ?? snapshot?.candidate?.id ?? snapshot?.latest?.id ?? null
    setSelectedReportId(preferred)
    setNotice(null)
  }

  function runGenerate(planId: number, forceFullScan: boolean) {
    const result = generateComparisonReport(planId, { forceFullScan })
    if (!result.ok) {
      withNotice('error', result.message)
      return
    }
    withNotice('ok', result.message, result.report?.id ?? null)
  }

  function runSaveConfig() {
    if (!selectedPlan) return
    const result = updateComparisonPlan(selectedPlan.id, {
      threshold: thresholdDraft.trim() === '' ? undefined : Number(thresholdDraft),
      significance: significanceDraft.trim() === '' ? undefined : Number(significanceDraft),
      dimensionsRaw: dimensionsDraft,
      metricsRaw: metricsDraft,
    })
    if (!result.ok) {
      withNotice('error', result.message)
      return
    }
    withNotice('ok', result.message, result.generated?.id ?? selectedReport?.id ?? null)
  }

  function runPublish(reportId: string) {
    const result = publishComparisonReport(reportId)
    withNotice(result.ok ? 'ok' : 'error', result.message, result.ok ? reportId : null)
  }

  function runRevoke(reportId: string) {
    const result = revokeComparisonReport(reportId)
    withNotice(result.ok ? 'ok' : 'error', result.message, reportId)
  }

  function runTogglePlan(planId: number, enabled: boolean) {
    const result = setComparisonPlanEnabled(planId, enabled)
    withNotice(result.ok ? 'ok' : 'error', result.message)
  }

  function runAudit() {
    const result = auditCompareWorkspace()
    setAuditLines(result.issues.length > 0 ? result.issues : ['没有发现重复明细、残留旧阈值判定或缺失字段'])
    withNotice(result.ok ? 'ok' : 'error', result.message)
  }

  function runDrill(reportId: string, level: number, parentItemKey: string | null): DrillResult | null {
    const result = drillComparisonReport(reportId, level, parentItemKey)
    if (!result.ok) {
      // 只有下钻失败才占用全局提示；成功时的定位说明由下钻面板自己展示，
      // 避免把页面顶部的数据异常提示覆盖掉。
      setNotice({ kind: 'error', text: result.message })
      return null
    }
    return result.result
  }

  return (
    <section className="page compare-page" data-module="compare">
      <header className="page-head">
        <div>
          <h2>对比分析管理</h2>
          <p className="page-desc">
            阈值口径：相对差异百分比（{THRESHOLD_POLICY}）。只调阈值时复用未变化维度切片，仅重算临界带内的切片；
            报告发布后判定结果冻结，新结果以候选版本并存。
          </p>
        </div>
        <div className="page-actions">
          <button className="btn" type="button" onClick={runAudit}>清理异常明细</button>
          <button className="btn" type="button" onClick={() => downloadEntries(meta.key)}>导出对比分析清单</button>
        </div>
      </header>

      <div className="stat-row">
        {stats.map((item) => (
          <article key={item.label} className="stat-card">
            <span className="stat-label">{item.label}</span>
            <strong className="stat-value">{item.value}</strong>
          </article>
        ))}
      </div>

      {notice && (
        <p className={notice.kind === 'error' ? 'notice error' : 'notice ok'} role="status">
          {notice.text}
        </p>
      )}
      {auditLines.length > 0 && (
        <ul className="audit-list">
          {auditLines.map((line) => <li key={line}>{line}</li>)}
        </ul>
      )}

      <section className="panel">
        <h3 className="panel-title">对比方案与报告口径</h3>
        <table className="data-table">
          <thead>
            <tr>
              <th>方案</th>
              <th>基准 / 对照数据集</th>
              <th>对比维度</th>
              <th>对比指标</th>
              <th>阈值 / 显著性</th>
              <th>已发布</th>
              <th>候选</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {snapshots.map((snapshot) => {
              const { plan, published, candidate } = snapshot
              return (
                <tr
                  key={plan.id}
                  className={plan.id === selectedPlanId ? 'row-active' : undefined}
                  onClick={() => selectPlan(plan.id)}
                >
                  <td>
                    <strong>{plan.code}</strong>
                    <div className="muted">#{plan.id}</div>
                  </td>
                  <td>
                    <div>{datasetName(plan.baseDatasetId)}</div>
                    <div className="muted">对照：{datasetName(plan.compareDatasetId)}</div>
                  </td>
                  <td>{plan.dimensions.join(' → ')}</td>
                  <td>{plan.metrics.join(', ')}</td>
                  <td>
                    <div>{plan.threshold}%</div>
                    <div className="muted">α={plan.significance}</div>
                  </td>
                  <td>{published ? `v${published.version}` : '—'}</td>
                  <td>{candidate ? `v${candidate.version}（候选）` : '—'}</td>
                  <td>
                    <span className={plan.disabled ? 'tag muted-tag' : 'tag'}>{plan.status}</span>
                  </td>
                  <td className="row-actions" onClick={(event) => event.stopPropagation()}>
                    <button className="link" type="button" onClick={() => runGenerate(plan.id, false)}>生成报告</button>
                    <button className="link" type="button" onClick={() => runGenerate(plan.id, true)}>全量重算</button>
                    <button className="link" type="button" onClick={() => runTogglePlan(plan.id, plan.disabled)}>
                      {plan.disabled ? '启用方案' : '停用方案'}
                    </button>
                  </td>
                </tr>
              )
            })}
            {snapshots.length === 0 && (
              <tr><td className="empty-state" colSpan={9}>暂无对比分析方案</td></tr>
            )}
          </tbody>
        </table>
      </section>

      {selectedPlan && (
        <section className="panel">
          <h3 className="panel-title">调整对比方案 · {selectedPlan.code}</h3>
          <div className="config-grid">
            <label className="filter-item">
              <span>差异阈值（相对差异 %）</span>
              <input value={thresholdDraft} onChange={(event) => setThresholdDraft(event.target.value)} />
            </label>
            <label className="filter-item">
              <span>显著性水平 α（0 ~ 0.5）</span>
              <input value={significanceDraft} onChange={(event) => setSignificanceDraft(event.target.value)} />
            </label>
            <label className="filter-item wide">
              <span>对比维度（顺序与大小写会自动规范化）</span>
              <input value={dimensionsDraft} onChange={(event) => setDimensionsDraft(event.target.value)} />
            </label>
            <label className="filter-item wide">
              <span>对比指标</span>
              <input value={metricsDraft} onChange={(event) => setMetricsDraft(event.target.value)} />
            </label>
            <button className="btn primary" type="button" onClick={runSaveConfig}>保存并生成候选</button>
          </div>
          <p className="hint">
            {selectedPlan.disabled
              ? '方案已停用：保存修改只会生成候选报告，已发布报告与差异明细继续可读、可下钻。'
              : '阈值或显著性变化会自动生成候选；未经变化的切面直接复用，不重扫全部维度。'}
          </p>
        </section>
      )}

      <div className="compare-columns">
        <section className="panel report-list">
          <h3 className="panel-title">判定报告版本</h3>
          {planReports.length === 0 && <p className="hint">该方案还没有报告，先执行「生成报告」。</p>}
          <ul className="report-list-items">
            {planReports.map((report) => (
              <li
                key={report.id}
                className={report.id === selectedReport?.id ? 'report-item active' : 'report-item'}
                onClick={() => setSelectedReportId(report.id)}
              >
                <div className="report-item-head">
                  <strong>v{report.version}</strong>
                  <span className={`tag state-${report.state}`}>{describeState(report.state)}</span>
                  {report.supersededAt && <span className="tag muted-tag">历史版本</span>}
                </div>
                <div className="muted">
                  {describeReason(report.reason)} · 阈值 {report.threshold}% · α={report.significance}
                </div>
                <div className="muted small">
                  基准快照 {report.baselineSnapshotId} / 对照快照 {report.comparisonSnapshotId}
                </div>
                <div className="muted small">
                  {report.scan?.fullScan
                    ? `全量扫描 ${report.scan.scannedSlices} 个切片`
                    : `复用 ${report.scan?.reusedSlices ?? 0} 个切片，重算 ${report.scan?.recomputedSlices ?? 0} 个`}
                  {' · '}差异 {report.summary?.differenceCount ?? 0} / 未归类 {report.summary?.unclassifiedCount ?? 0}
                </div>
                <div className="row-actions">
                  {(report.state === 'candidate' && !report.supersededAt) && (
                    <button className="link" type="button" onClick={() => runPublish(report.id)}>发布</button>
                  )}
                  {report.state === 'published' && (
                    <button className="link" type="button" onClick={() => runRevoke(report.id)}>撤销发布</button>
                  )}
                  <button className="link" type="button" onClick={() => setSelectedReportId(report.id)}>查看明细</button>
                </div>
              </li>
            ))}
          </ul>
        </section>

        <section className="panel report-detail">
          <h3 className="panel-title">当前报告判定</h3>
          {!selectedReport && <p className="hint">请选择一份报告。</p>}
          {selectedReport && (
            <>
              <dl className="report-meta">
                <div><dt>版本</dt><dd>v{selectedReport.version}（{describeState(selectedReport.state)}）</dd></div>
                <div><dt>生成原因</dt><dd>{describeReason(selectedReport.reason)}</dd></div>
                <div><dt>判定口径</dt><dd>阈值 {selectedReport.threshold}% 相对差异 · α={selectedReport.significance} · {selectedReport.thresholdPolicy}</dd></div>
                <div><dt>基准快照</dt><dd>{selectedReport.baselineSnapshotId}（{selectedReport.baseDatasetName}）</dd></div>
                <div><dt>对照快照</dt><dd>{selectedReport.comparisonSnapshotId}（{selectedReport.compareDatasetName}）</dd></div>
                <div><dt>复用 / 重算</dt><dd>{selectedReport.summary?.reusedCount ?? 0} 条复用 · {selectedReport.summary?.recomputedCount ?? 0} 条重算判定</dd></div>
              </dl>
              <p className="hint">
                发布后的判定结果已冻结在该版本中；后续阈值或显著性调整只会生成新的候选报告，不会覆盖这里。
              </p>
            </>
          )}
        </section>
      </div>

      {selectedReport && (
        <CompareDrillPanel
          report={selectedReport}
          onDrill={runDrill}
          onSelectReport={setSelectedReportId}
        />
      )}

      <section className="panel">
        <h3 className="panel-title">对比方案登记清单（与方案报告口径同步）</h3>
        <table className="data-table">
          <thead>
            <tr>{columns.map((column) => <th key={column}>{column}</th>)}<th>当前状态</th></tr>
          </thead>
          <tbody>
            {snapshots.map(({ plan }) => {
              const entry = entryRows.find((row) => Number(row.id) === plan.id)
              return (
                <tr key={plan.id}>
                  {columns.map((column) => {
                    if (column === '对比维度') return <td key={column}>{plan.dimensions.join(', ')}</td>
                    if (column === '对比指标') return <td key={column}>{plan.metrics.join(', ')}</td>
                    if (column === '差异阈值') return <td key={column}>{plan.threshold}%</td>
                    if (column === '显著性水平') return <td key={column}>{plan.significance}</td>
                    if (column === '基准数据集') return <td key={column}>{datasetName(plan.baseDatasetId)}</td>
                    if (column === '对照数据集') return <td key={column}>{datasetName(plan.compareDatasetId)}</td>
                    if (column === '方案编号') return <td key={column}>{plan.code}</td>
                    if (column === '输出展示') return <td key={column}>{entry?.[column] ?? plan.outputMode}</td>
                    return <td key={column}>{entry?.[column] ?? '—'}</td>
                  })}
                  <td>{plan.status}</td>
                </tr>
              )
            })}
            {snapshots.length === 0 && (
              <tr><td className="empty-state" colSpan={columns.length + 1}>暂无对比分析数据，可先登记对比方案</td></tr>
            )}
          </tbody>
        </table>
      </section>
    </section>
  )
}
