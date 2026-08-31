import {
	AsYouType,
	type CountryCode,
	getCountryCallingCode,
	parsePhoneNumberFromString,
} from "libphonenumber-js";
import { CheckCircle2, XCircle } from "lucide-react";
import * as React from "react";

import { Input } from "#/components/ui/input.tsx";
import { cn } from "#/lib/utils.ts";

/**
 * Entrada de teléfono con formateo en vivo e icono de válido/inválido.
 *
 * Es el **mismo componente que el Identity Server** (`ui/phone-input.tsx` en su
 * frontend), replicado para que el número se teclee igual en los dos sistemas: si
 * alguien empieza a escribir sin "+", se antepone el código de `defaultCountry`
 * para que se vea desde la primera tecla; si teclea su propio "+", se respeta ese
 * país. La validación de fondo es la misma (`phoneSchema` en
 * `@elineas/validations`).
 */
export interface PhoneInputProps
	extends Omit<React.ComponentProps<"input">, "type" | "value" | "onChange"> {
	value?: string;
	onChange?: (value: string) => void;
	/** País por defecto (ISO 3166-1 alpha-2) para el prefijo y el formateo. */
	defaultCountry?: CountryCode;
}

function PhoneInput({
	className,
	value,
	onChange,
	defaultCountry = "CU",
	...props
}: PhoneInputProps) {
	const [internalValue, setInternalValue] = React.useState(value ?? "");
	const isControlled = value !== undefined;
	const currentValue = isControlled ? (value ?? "") : internalValue;
	const callingCode = getCountryCallingCode(defaultCountry);

	function handleChange(event: React.ChangeEvent<HTMLInputElement>) {
		let raw = event.target.value;
		if (raw && !raw.startsWith("+") && !currentValue) {
			raw = `+${callingCode}${raw}`;
		}
		const formatted = new AsYouType(defaultCountry).input(raw);
		if (!isControlled) setInternalValue(formatted);
		onChange?.(formatted);
	}

	const nationalDigits = currentValue
		.replace(/\D/g, "")
		.replace(new RegExp(`^${callingCode}`), "");
	const showStatus = nationalDigits.length > 0;
	const isValid = parsePhoneNumberFromString(currentValue)?.isValid() ?? false;

	return (
		<div className="relative">
			<Input
				type="tel"
				inputMode="tel"
				data-slot="phone-input"
				value={currentValue}
				onChange={handleChange}
				className={cn("pr-9", className)}
				{...props}
			/>
			{showStatus && (
				<div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3">
					{isValid ? (
						<CheckCircle2
							className="size-4 text-emerald-600"
							aria-label="Número válido"
						/>
					) : (
						<XCircle
							className="size-4 text-destructive"
							aria-label="Número no válido"
						/>
					)}
				</div>
			)}
		</div>
	);
}

export { PhoneInput };
