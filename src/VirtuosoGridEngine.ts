import * as React from 'react'
import { subject, map, combineLatest, withLatestFrom, coldSubject } from './tinyrx'
import { makeInput, makeOutput } from './rxio'
import { TScrollLocation, TContainer, buildIsScrolling } from './EngineCommons'
import { ListRange, scrollSeekEngine } from './engines/scrollSeekEngine'

type GridDimensions = [
  number, // container width,
  number, // container height,
  number | undefined, // item container width,
  number | undefined, // item container height
  number | undefined, // item content width
  number | undefined // item content height
]

type GridItemRange = [
  number, // start index
  number // end index
]

type GridItemsRenderer = (
  item: (index: number) => React.ReactElement,
  itemClassName: string,
  ItemContainer: TContainer,
  computeItemKey: (index: number) => number,
  totalCount: number
) => React.ReactElement[]

const { ceil, floor, min, max } = Math

const hackFloor = (val: number) => (ceil(val) - val < 0.03 ? ceil(val) : floor(val))

const calculateItemsPerRow = (viewportWidth: number, itemWidth: number) => hackFloor(viewportWidth / itemWidth)

const toRowIndex = (index: number, itemsPerRow: number, roundFunc = floor) => roundFunc(index / itemsPerRow)

export const VirtuosoGridEngine = (initialItemCount = 0) => {
  const itemsRender = subject<any>(false)
  const gridDimensions$ = subject<GridDimensions>([0, 0, undefined, undefined, undefined, undefined])
  const totalCount$ = subject(0)
  const scrollTop$ = subject(0)
  const overscan$ = subject(0)
  const itemRange$ = subject<GridItemRange>([0, max(initialItemCount - 1, 0)])
  const remainingHeight$ = subject(0)
  const listOffset$ = subject(0)
  const scrollToIndex$ = coldSubject<TScrollLocation>()
  const rangeChanged$ = coldSubject<ListRange>()
  const endThreshold$ = subject(0)

  combineLatest(gridDimensions$, scrollTop$, overscan$, totalCount$)
    .pipe(withLatestFrom(itemRange$))
    .subscribe(
      ([[[viewportWidth, viewportHeight, itemWidth, itemHeight], scrollTop, overscan, totalCount], itemRange]) => {
        if (itemWidth === undefined || itemHeight === undefined) {
          return
        }

        if (totalCount === 0) {
          itemRange$.next([0, -1])
          listOffset$.next(0)
          rangeChanged$.next({ startIndex: 0, endIndex: -1 })
          return
        }

        const [startIndex, endIndex] = itemRange
        const itemsPerRow = calculateItemsPerRow(viewportWidth, itemWidth)

        const updateRange = (down: boolean): void => {
          const [topOverscan, bottomOverscan] = down ? [0, overscan] : [overscan, 0]

          let startIndex = itemsPerRow * floor((scrollTop - topOverscan) / itemHeight)

          let endIndex = itemsPerRow * ceil((scrollTop + viewportHeight + bottomOverscan) / itemHeight) - 1

          endIndex = min(totalCount - 1, endIndex)
          startIndex = min(endIndex, max(0, startIndex))

          itemRange$.next([startIndex, endIndex])
          listOffset$.next(toRowIndex(startIndex, itemsPerRow) * itemHeight)
          rangeChanged$.next({ startIndex, endIndex })
        }

        const listTop = itemHeight * toRowIndex(startIndex, itemsPerRow)
        const listBottom = itemHeight * toRowIndex(endIndex, itemsPerRow) + itemHeight

        // totalCount has decreased, we have to re-render
        if (totalCount < endIndex - 1) {
          updateRange(true)
          // user is scrolling up - list top is below the top edge of the viewport
        } else if (listTop > scrollTop) {
          updateRange(false)
          // user is scrolling down - list bottom is above the bottom edge of the viewport
        } else if (listBottom < scrollTop + viewportHeight) {
          updateRange(true)
        }
      }
    )

  const scrollTo$ = scrollToIndex$.pipe(
    withLatestFrom(gridDimensions$, totalCount$),
    map(([location, [viewportWidth, viewportHeight, itemWidth, itemHeight], totalCount]) => {
      if (itemWidth === undefined || itemHeight === undefined) {
        return { top: 0, behavior: 'auto' } as ScrollOptions
      }

      if (typeof location === 'number') {
        location = { index: location, align: 'start' }
      }

      let { index, align = 'start', behavior = 'auto' } = location

      index = Math.max(0, index, Math.min(totalCount - 1, index))

      const itemsPerRow = hackFloor(viewportWidth / itemWidth)

      let offset = floor(index / itemsPerRow) * itemHeight

      if (align === 'end') {
        offset = offset - viewportHeight + itemHeight
      } else if (align === 'center') {
        offset = Math.round(offset - viewportHeight / 2 + itemHeight / 2)
      }

      return { top: offset, behavior } as ScrollToOptions
    })
  )

  const isScrolling$ = buildIsScrolling(scrollTop$)

  const endReached$ = coldSubject<number>()
  let currentEndIndex = 0

  itemRange$.pipe(withLatestFrom(totalCount$, endThreshold$)).subscribe(([[_, endIndex], totalCount, endThreshold]) => {
    if (totalCount === 0) {
      return
    }

    if (endIndex >= totalCount - endThreshold) {
      if (currentEndIndex !== endIndex) {
        currentEndIndex = endIndex
        endReached$.next(endIndex)
      }
    }
  })

  const { isSeeking$, scrollSeekConfiguration$ } = scrollSeekEngine({
    scrollTop$,
    isScrolling$,
    rangeChanged$,
  })

  combineLatest(itemRange$, isSeeking$, scrollSeekConfiguration$, gridDimensions$)
    .pipe(
      map(([[startIndex, endIndex], renderPlaceholder, scrollSeek, [_, __, ___, ____, _____, itemHeight]]) => {
        const render: GridItemsRenderer = (item, itemClassName, ItemContainer, computeItemKey, totalCount) => {
          const items = []
          const end = Math.min(endIndex, totalCount - 1)
          for (let index = startIndex; index <= end; index++) {
            const key = computeItemKey(index)
            let children: React.ReactElement

            if (scrollSeek && renderPlaceholder && itemHeight) {
              children = React.createElement(scrollSeek.placeholder, {
                height: itemHeight,
                index,
              })
            } else {
              children = item(index)
            }

            items.push(
              React.createElement(
                ItemContainer,
                {
                  key,
                  className: itemClassName,
                },
                children
              )
            )
          }

          return items
        }
        return { render }
      })
    )
    .subscribe(itemsRender.next)

  combineLatest(gridDimensions$, totalCount$, itemRange$).subscribe(
    ([[viewportWidth, _, itemWidth, itemHeight], totalCount, itemRange]) => {
      if (itemWidth === undefined || itemHeight === undefined) {
        return
      }

      if (totalCount === 0) {
        remainingHeight$.next(0)
        return
      }

      const [, endIndex] = itemRange
      const itemsPerRow = calculateItemsPerRow(viewportWidth, itemWidth)
      const remainingCount = toRowIndex(max(totalCount - endIndex - 1, 0), itemsPerRow, ceil)

      remainingHeight$.next(itemHeight * remainingCount)
    }
  )

  return {
    gridDimensions: makeInput(gridDimensions$),
    totalCount: makeInput(totalCount$),
    scrollTop: makeInput(scrollTop$),
    overscan: makeInput(overscan$),
    scrollToIndex: makeInput(scrollToIndex$),
    scrollSeekConfiguration: makeInput(scrollSeekConfiguration$),
    endThreshold: makeInput(endThreshold$),

    itemsRender: makeOutput(itemsRender),
    itemRange: makeOutput(itemRange$),
    remainingHeight: makeOutput(remainingHeight$),
    listOffset: makeOutput(listOffset$),
    scrollTo: makeOutput(scrollTo$),
    isScrolling: makeOutput(isScrolling$),
    endReached: makeOutput(endReached$),
    rangeChanged: makeOutput(rangeChanged$),
  }
}
