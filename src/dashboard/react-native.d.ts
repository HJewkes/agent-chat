/**
 * Ambient types for the `react-native` specifier, which Vite aliases to
 * `react-native-web`.
 *
 * Needed because react-native-web ships no type declarations of its own and the
 * real `@types/react-native` describes a native runtime this code never touches
 * — it would pull in Animated, Platform, native module typings and a `style`
 * model that disagrees with what react-native-web accepts on the web (`cursor`,
 * `boxShadow`, `overflowY`, percentage widths, `100vh`).
 *
 * So this declares exactly the surface the copied kit uses, with `style` typed
 * loosely on purpose: brain's components pass web-only CSS properties through
 * these props deliberately, and a stricter type here would reject working code
 * rather than catch a bug. Everything else — props, children, callbacks — is
 * checked normally.
 *
 * Brain never typechecked its dashboard at all (`src/dashboard` is in its
 * tsconfig `exclude` with no replacement config). This file plus
 * `src/dashboard/tsconfig.json` is the part of the copy that is an improvement
 * on the original rather than a faithful reproduction of it.
 */
declare module 'react-native' {
  import type * as React from 'react'

  /** Web-permissive style bag: a value, an array of them, or a falsy slot. */
  type StyleValue = Record<string, unknown>
  export type StyleProp = StyleValue | false | null | undefined | ReadonlyArray<StyleProp>

  interface BaseProps {
    style?: StyleProp
    children?: React.ReactNode
    testID?: string
  }

  export interface ViewProps extends BaseProps {
    pointerEvents?: 'auto' | 'none' | 'box-none' | 'box-only'
    onLayout?: (event: { nativeEvent: { layout: { width: number; height: number } } }) => void
  }
  export const View: React.ComponentType<ViewProps>

  export interface TextProps extends BaseProps {
    numberOfLines?: number
    selectable?: boolean
    onPress?: () => void
  }
  export const Text: React.ComponentType<TextProps>

  export interface PressableProps extends Omit<BaseProps, 'style'> {
    style?: StyleProp | ((state: { pressed: boolean; hovered?: boolean }) => StyleProp)
    onPress?: () => void
    onHoverIn?: () => void
    onHoverOut?: () => void
    disabled?: boolean
  }
  export const Pressable: React.ComponentType<PressableProps>

  export interface ScrollViewProps extends BaseProps {
    contentContainerStyle?: StyleProp
    horizontal?: boolean
    showsVerticalScrollIndicator?: boolean
    showsHorizontalScrollIndicator?: boolean
  }
  export const ScrollView: React.ComponentType<ScrollViewProps>

  export interface TextInputProps extends BaseProps {
    value?: string
    placeholder?: string
    placeholderTextColor?: string
    autoFocus?: boolean
    onChangeText?: (text: string) => void
    onSubmitEditing?: () => void
  }
  export const TextInput: React.ComponentType<TextInputProps>

  export const StyleSheet: {
    /** Identity at runtime on the web; typed as identity so keys stay inferred. */
    create<T extends Record<string, unknown>>(styles: T): T
    flatten(style: StyleProp): StyleValue
    absoluteFill: StyleValue
    readonly hairlineWidth: number
  }
}
