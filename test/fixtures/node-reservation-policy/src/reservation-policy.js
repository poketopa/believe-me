export function canReserve(remainingSeats, requestedSeats) {
  return Number.isInteger(remainingSeats) &&
    Number.isInteger(requestedSeats) &&
    requestedSeats > 0 &&
    remainingSeats >= requestedSeats;
}
