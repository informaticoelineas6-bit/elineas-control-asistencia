1. Las acciones de la tabla deben ser un dropdown con botones o  enlaces.
2. Para todas las acciones que sean de marcar asistencia debe crearse un calendario usando las utilidaddes de date-fns que cuente con todas las funcoinalidades
   → Hecho en la spec 07: el calendario es `apps/frontend/src/components/ui/calendar.tsx`
   (date-fns, selección simple / múltiple / por rango, celdas con espacio para marcas, varios
   meses, números de semana, teclado). **Es el único calendario del proyecto**: las pantallas de
   marcaje, descansos y vacaciones lo reutilizan en vez de añadir otro.
