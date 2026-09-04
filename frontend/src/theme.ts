import { Badge, Button, Container, createTheme, Paper, rem, Tabs, TextInput } from "@mantine/core"

/**
 * Theme for a DAQ control panel.
 *
 * The same reasoning as the vacuum and actuator panels it sits beside: the
 * screen is read from a metre away in a lit room, so type and targets are
 * large, and the accent colour is spent only on controls that do something.
 * Wider than those, because this page carries a ten-column table and a chart
 * side by side and both want the room.
 */
export const CONTENT_WIDTH = 1440

export const theme = createTheme({
  primaryColor: "blue",
  primaryShade: 7,
  defaultRadius: "md",

  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  fontFamilyMonospace: '"Geist Mono Variable", ui-monospace, SFMono-Regular, monospace',
  headings: { fontWeight: "600" },

  fontSizes: {
    xs: rem(12),
    sm: rem(13),
    md: rem(14),
    lg: rem(16),
    xl: rem(19),
  },
  lineHeights: { md: "1.5" },
  spacing: { xs: rem(8), sm: rem(12), md: rem(16), lg: rem(24), xl: rem(36) },

  components: {
    Button: Button.extend({ defaultProps: { size: "sm", radius: "md" } }),
    TextInput: TextInput.extend({ defaultProps: { size: "sm" } }),
    Tabs: Tabs.extend({ defaultProps: { variant: "default" } }),
    Paper: Paper.extend({ defaultProps: { radius: "md" } }),
    Badge: Badge.extend({
      // Names like "Running" and "Not connected" are read as words, not shouted.
      styles: { label: { textTransform: "none" } },
    }),
    Container: Container.extend({ defaultProps: { size: CONTENT_WIDTH } }),
  },
})
