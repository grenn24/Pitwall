import type { PitwallApi } from './index'

declare global {
  interface Window {
    pitwall: PitwallApi
  }
}

export {}
