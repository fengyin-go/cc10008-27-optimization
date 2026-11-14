import { COMPARE_DATASETS, COMPARE_PLANS } from './compare-seed'
import type {
  CompareWorkspaceState,
  ComparisonDataset,
  ComparisonPlan,
  ComparisonReport,
} from './compare-types'

// 对比分析独立持久化：报告是发布物，不能因为别的模块重置或页面刷新就改写判定。
const STORAGE_KEY = 'interactive-analytics-lab:compare-workspace'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function emptyState(): CompareWorkspaceState {
  return { version: 1, reports: [], plans: clone(COMPARE_PLANS) }
}

function readStorage(): CompareWorkspaceState {
  if (typeof window === 'undefined' || !window.localStorage) {
    return emptyState()
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    return emptyState()
  }
  try {
    const parsed = JSON.parse(raw) as Partial<CompareWorkspaceState>
    if (!parsed || !Array.isArray(parsed.reports)) {
      return emptyState()
    }
    return {
      version: 1,
      reports: parsed.reports,
      // 旧版本地数据可能没有 plans：用示例方案补上，已调整过的阈值仍以本地为准。
      plans: Array.isArray(parsed.plans) && parsed.plans.length > 0 ? parsed.plans : clone(COMPARE_PLANS),
    }
  } catch {
    return emptyState()
  }
}

let cache: CompareWorkspaceState | null = null

export function workspace(): CompareWorkspaceState {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function saveWorkspace(next: CompareWorkspaceState): void {
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function invalidateWorkspaceCache(): void {
  cache = null
}

export function datasets(): ComparisonDataset[] {
  return clone(COMPARE_DATASETS)
}

export function datasetById(id: string): ComparisonDataset | undefined {
  const found = COMPARE_DATASETS.find((item) => item.id === id)
  return found ? clone(found) : undefined
}

export function plans(): ComparisonPlan[] {
  return clone(workspace().plans)
}

export function planById(id: number): ComparisonPlan | undefined {
  const found = workspace().plans.find((item) => item.id === id)
  return found ? clone(found) : undefined
}

export function savePlan(plan: ComparisonPlan): void {
  const state = workspace()
  const next = state.plans.map((item) => (item.id === plan.id ? clone(plan) : item))
  saveWorkspace({ ...state, plans: next })
}

export function reports(): ComparisonReport[] {
  return workspace().reports
}

export function saveReports(next: ComparisonReport[]): void {
  const state = workspace()
  saveWorkspace({ ...state, reports: next })
}

export function appendReport(report: ComparisonReport): void {
  saveReports([...reports(), report])
}

export function replaceReport(report: ComparisonReport): void {
  saveReports(reports().map((item) => (item.id === report.id ? report : item)))
}

export function resetWorkspace(): void {
  saveWorkspace(emptyState())
}

export function compareStorageKey(): string {
  return STORAGE_KEY
}
