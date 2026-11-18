/** Segmented pill toggle shared by settings panels. */
export function Segment<T extends string>(props: {
  value: T
  options: readonly (readonly [T, string])[]
  onChange: (value: T) => void
  disabled?: boolean
}) {
  return (
    <div className="rwkv-segment" role="group">
      {props.options.map(([value, label]) => (
        <button key={value} type="button" aria-pressed={props.value === value} disabled={props.disabled} onClick={() => props.onChange(value)}>{label}</button>
      ))}
    </div>
  )
}
