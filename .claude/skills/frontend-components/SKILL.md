---
name: frontend-components
description: Reuse existing UI components and follow Tailwind v4 patterns in the frontend
---

## Reuse Existing Components

Always check for and use existing components before creating new HTML elements or custom styling. Never use raw `<button>`, `<input>`, `<table>`, etc. when a component exists.

### UI Components (`@website/components/ui/`)

| Component                                                          | Use instead of                                                                                                                                 |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `Button`                                                           | `<button>` — supports `variant` (`default`, `ghost`, `outline`, `destructive`, `link`, `secondary`) and `size` (`default`, `sm`, `lg`, `icon`) |
| `Input`                                                            | `<input type="text">`                                                                                                                          |
| `Textarea`                                                         | `<textarea>`                                                                                                                                   |
| `Checkbox`                                                         | `<input type="checkbox">`                                                                                                                      |
| `RadioGroup` + `RadioGroupItem`                                    | `<input type="radio">`                                                                                                                         |
| `Select` + `SelectTrigger` + `SelectContent` + `SelectItem`        | `<select>`                                                                                                                                     |
| `Label`                                                            | `<label>`                                                                                                                                      |
| `Card` + `CardHeader` + `CardTitle` + `CardContent` + `CardFooter` | Card-like containers                                                                                                                           |
| `Badge`                                                            | Status tags, labels, chips                                                                                                                     |
| `Table` + `TableHeader` + `TableBody` + `TableRow` + `TableCell`   | `<table>`                                                                                                                                      |
| `Dialog` + `DialogTrigger` + `DialogContent`                       | Modal dialogs                                                                                                                                  |
| `Sheet` + `SheetTrigger` + `SheetContent`                          | Side panels / drawers                                                                                                                          |
| `Tabs` + `TabsList` + `TabsTrigger` + `TabsContent`                | Tab navigation                                                                                                                                 |
| `ScrollArea`                                                       | Scrollable containers                                                                                                                          |
| `Slider`                                                           | Range inputs                                                                                                                                   |
| `Switch`                                                           | Toggle switches                                                                                                                                |
| `Tooltip` + `TooltipTrigger` + `TooltipContent`                    | Hover tooltips                                                                                                                                 |
| `Skeleton`                                                         | Loading placeholders                                                                                                                           |
| `Spinner`                                                          | Loading spinners                                                                                                                               |
| `LoadingButton`                                                    | Button with loading state                                                                                                                      |
| `Separator`                                                        | `<hr>`                                                                                                                                         |
| `Alert` + `AlertTitle` + `AlertDescription`                        | Alert banners                                                                                                                                  |
| `Accordion`                                                        | Collapsible sections                                                                                                                           |
| `DropdownMenu`                                                     | Context menus / action menus                                                                                                                   |
| `Popover`                                                          | Floating content                                                                                                                               |
| `HoverCard`                                                        | Rich hover previews                                                                                                                            |
| `Calendar`                                                         | Date pickers                                                                                                                                   |
| `Pagination`                                                       | Page navigation                                                                                                                                |
| `Progress`                                                         | Progress bars                                                                                                                                  |
| `Form`                                                             | React Hook Form wrapper (with `FormField`, `FormItem`, `FormLabel`, `FormControl`, `FormMessage`)                                              |

### AI Chat Components (`@website/components/ai-elements/`)

For any AI chat interface, use these existing components:

| Component                                                                                              | Purpose                                 |
| ------------------------------------------------------------------------------------------------------ | --------------------------------------- |
| `Conversation` + `ConversationContent` + `ConversationScrollButton` + `ConversationEmptyState`         | Chat message container with auto-scroll |
| `Message` + `MessageContent`                                                                           | Individual chat message bubble          |
| `Response`                                                                                             | Markdown-rendered AI response text      |
| `PromptInput` + `PromptInputBody` + `PromptInputTextarea` + `PromptInputToolbar` + `PromptInputSubmit` | Chat input area                         |
| `PromptInputMicrophone`                                                                                | Voice input button                      |
| `Loader`                                                                                               | Streaming/thinking indicator            |
| `Tool` + `ToolHeader` + `ToolContent` + `ToolOutput`                                                   | Tool call display                       |
| `Reasoning` + `ReasoningTrigger` + `ReasoningContent`                                                  | Expandable reasoning display            |
| `Suggestion` + `Suggestions`                                                                           | Quick reply suggestion chips            |

### Toast Notifications

Use `toast` from `sonner` (already configured via `<Toaster />` in the layout):

```tsx
import { toast } from "sonner"

toast.success("Saved", { description: "Your changes have been saved." })
toast.error("Error", { description: "Something went wrong." })
```

## Tailwind v4

This project uses **Tailwind CSS v4**. Key differences from v3:

### Use `gap` instead of `space-*`

Tailwind v4 dropped `space-x-*` and `space-y-*` utilities. Use flex/grid `gap` instead:

```tsx
// Bad (v3 pattern)
<div className="space-y-4">

// Good (v4 pattern)
<div className="flex flex-col gap-4">
```

### CSS-first configuration

Tailwind v4 uses CSS-based config (`globals.css` with `@theme`) instead of `tailwind.config.js`. Custom values are defined in `apps/website/src/app/globals.css`.

### Icons

Use `lucide-react` for icons. Import individual icons:

```tsx
import { ChevronRight, Plus, Trash2 } from "lucide-react"
;<ChevronRight className="h-4 w-4" />
```
