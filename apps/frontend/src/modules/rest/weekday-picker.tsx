import {
	DAY_OF_WEEK_NAMES,
	DAY_OF_WEEK_SHORT_NAMES,
	DAYS_OF_WEEK_DISPLAY_ORDER,
} from "@elineas/validations";
import { cn } from "#/lib/utils.ts";

/**
 * Selector de días de la semana (spec 10 §7).
 *
 * Dos cosas que no son cosméticas:
 *
 * - **Se pinta empezando en lunes y se guarda con 0 = domingo.** El orden de
 *   presentación sale de `DAYS_OF_WEEK_DISPLAY_ORDER` y los valores conservan la
 *   convención de almacenamiento (decisión 1 de la §9), así que no hay ninguna
 *   traducción que alguien pueda olvidar. Es la lista que el editor del calendario
 *   laboral tenía escrita a mano y que ahora comparten los dos.
 * - **Los botones son `aria-pressed` dentro de un `fieldset`, no casillas
 *   disfrazadas.** Es un grupo de alternancia: se recorre con el tabulador y se
 *   activa con espacio o intro, y un lector de pantalla dice "martes, no pulsado"
 *   en vez de leer siete etiquetas sueltas.
 */
export function WeekdayPicker({
	value,
	onChange,
	disabled = false,
	label = "Días de descanso",
	className,
}: {
	value: readonly number[];
	onChange: (days: number[]) => void;
	disabled?: boolean;
	label?: string;
	className?: string;
}) {
	const toggle = (day: number) => {
		if (disabled) return;
		onChange(
			value.includes(day)
				? value.filter((each) => each !== day)
				: [...value, day].sort((a, b) => a - b),
		);
	};

	return (
		<fieldset
			aria-label={label}
			className={cn("flex flex-wrap gap-1.5", className)}
		>
			{DAYS_OF_WEEK_DISPLAY_ORDER.map((day) => {
				const active = value.includes(day);
				return (
					<button
						key={day}
						type="button"
						aria-pressed={active}
						aria-label={DAY_OF_WEEK_NAMES[day]}
						disabled={disabled}
						onClick={() => toggle(day)}
						className={cn(
							"min-w-12 rounded-md border px-2.5 py-1.5 text-xs transition-colors",
							active
								? "border-primary bg-primary/15 font-medium"
								: "border-input hover:bg-accent/60",
							disabled && "cursor-not-allowed opacity-60 hover:bg-transparent",
						)}
					>
						{DAY_OF_WEEK_SHORT_NAMES[day]}
					</button>
				);
			})}
		</fieldset>
	);
}
