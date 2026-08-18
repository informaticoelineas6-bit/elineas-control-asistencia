import { Monitor, Moon, Sun } from "lucide-react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu.tsx";
import {
	SidebarMenuButton,
	SidebarMenuItem,
} from "#/components/ui/sidebar.tsx";
import { THEME_LABELS, type Theme } from "#/modules/theme/theme.ts";
import { useTheme } from "#/modules/theme/use-theme.ts";

const ICONS: Record<Theme, typeof Sun> = {
	light: Sun,
	dark: Moon,
	system: Monitor,
};

const ORDER: Theme[] = ["light", "dark", "system"];

/**
 * Selector de tema para el pie del aside.
 *
 * Tres opciones y no un interruptor de dos: con un interruptor, "seguir al
 * sistema" se pierde en cuanto alguien lo toca una vez y no hay forma de volver.
 */
export function ThemeToggle() {
	const { theme, setTheme } = useTheme();
	const Icon = ICONS[theme];

	return (
		<SidebarMenuItem>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<SidebarMenuButton tooltip={`Tema: ${THEME_LABELS[theme]}`}>
						<Icon />
						<span>Tema: {THEME_LABELS[theme]}</span>
					</SidebarMenuButton>
				</DropdownMenuTrigger>
				<DropdownMenuContent side="top" align="start" className="w-40">
					{ORDER.map((option) => {
						const OptionIcon = ICONS[option];
						return (
							<DropdownMenuItem
								key={option}
								onSelect={() => setTheme(option)}
								className={option === theme ? "bg-accent" : undefined}
							>
								<OptionIcon />
								{THEME_LABELS[option]}
							</DropdownMenuItem>
						);
					})}
				</DropdownMenuContent>
			</DropdownMenu>
		</SidebarMenuItem>
	);
}
