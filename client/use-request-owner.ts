import { useEffect, useRef } from 'react'
import { RequestOwner } from './request-owner'

export function useRequestOwner(): RequestOwner {
  const owner = useRef<RequestOwner | null>(null)
  if (owner.current === null) owner.current = new RequestOwner()
  const current = owner.current
  useEffect(() => () => { current.cancel() }, [current])
  return current
}
