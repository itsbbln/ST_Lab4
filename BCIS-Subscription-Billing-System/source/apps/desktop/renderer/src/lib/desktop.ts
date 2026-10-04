/**
 * Printing, saving and native dialog wrappers.
 *
 * Route sheets, statements of account and remittance sheets are printed on
 * their own, without the sidebar and top bar. The shell registers a
 * `__bcisBeforePrint` hook that this module relies on, so printing works whether
 * it is triggered from a screen, the File menu or Ctrl+P.
 */

import { ApiError } from './api'
import { useConfig } from './config'

function bridgeAvailable(): boolean {
  return typeof window !== 'undefined' && typeof window.bcis?.print === 'function'
}

export async function printCurrent(mode: 'page' | 'window' = 'page'): Promise<void> {
  if (bridgeAvailable()) {
    await window.bcis.print(mode)
    return
  }
  window.print()
}

export async function confirmAction(options: {
  message: string
  detail?: string
  confirmLabel?: string
  danger?: boolean
}): Promise<boolean> {
  if (bridgeAvailable()) {
    return window.bcis.confirm(options)
  }
  return window.confirm(options.detail ? `${options.message}\n\n${options.detail}` : options.message)
}

export async function showMessage(options: {
  type?: 'none' | 'info' | 'error' | 'question' | 'warning'
  message: string
  detail?: string
}): Promise<void> {
  if (bridgeAvailable()) {
    await window.bcis.message(options)
    return
  }
  window.alert(options.detail ? `${options.message}\n\n${options.detail}` : options.message)
}

export async function openAppPath(target: 'userData' | 'logs' | 'backups'): Promise<void> {
  if (bridgeAvailable()) {
    await window.bcis.openPath(target)
  }
}

export function pickFile(options: {
  filters?: Array<{ name: string; extensions: string[] }>
  multiple?: boolean
}) {
  if (!bridgeAvailable()) {
    throw new Error('Selecting files is only available in the desktop application.')
  }
  return window.bcis.pickFile(options)
}

/**
 * Save a generated report. Uses the native save dialog so the operator chooses
 * where the PDF/XLSX/CSV lands, instead of it appearing in a downloads folder
 * they may not know exists.
 */
export async function saveReport(
  blob: Blob,
  suggestedName: string,
  format: 'csv' | 'xlsx' | 'pdf'
): Promise<string | null> {
  const extension = suggestedName.toLowerCase().endsWith(`.${format}`)
    ? suggestedName
    : `${suggestedName}.${format}`

  if (bridgeAvailable()) {
    const dataBase64 = await blobToBase64(blob)
    return window.bcis.saveFile({
      defaultPath: extension,
      dataBase64,
      filters: [{ name: format.toUpperCase(), extensions: [format] }]
    })
  }

  // Browser fallback so `vite dev` in a plain tab is still usable.
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = extension
  anchor.click()
  URL.revokeObjectURL(url)
  return extension
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('The export could not be prepared for saving.'))
    reader.onload = () => {
      const result = String(reader.result)
      resolve(result.slice(result.indexOf(',') + 1))
    }
    reader.readAsDataURL(blob)
  })
}

/**
 * Turn a thrown value into a sentence fit for an operator. Validation problems
 * are listed so a cashier can see exactly which field the server rejected.
 */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    const fields = Object.entries(error.fieldErrors)
    if (fields.length > 0) {
      return `${error.message} (${fields.map(([field, message]) => `${field}: ${message}`).join('; ')})`
    }
    return error.message
  }
  if (error instanceof Error) {
    return error.message
  }
  return 'Something went wrong.'
}

/**
 * Download a report export from the API and hand it to the native save dialog.
 * Shared by every report screen so the permissions check and filename rules
 * stay identical everywhere.
 */
export function useReportExport(): {
  exportReport: (
    path: string,
    query: Record<string, string | number | undefined>,
    format: 'csv' | 'xlsx' | 'pdf',
    suggestedName: string
  ) => Promise<void>
} {
  const { client } = useConfig()

  return {
    exportReport: async (path, query, format, suggestedName) => {
      const { blob, filename } = await client.download(path, query, format)
      const saved = await saveReport(blob, filename || suggestedName, format)
      if (saved) {
        await showMessage({
          type: 'info',
          message: 'Report saved',
          detail: saved
        })
      }
    }
  }
}
