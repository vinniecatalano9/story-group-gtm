// US area code -> IANA time zone, for picking a lead's send window.
// Anything not listed is Eastern. Split codes go with their biggest city
// (850 = Tallahassee, Eastern; 915 = El Paso, Mountain).

const ZONES = {
  'America/Los_Angeles': '209 213 279 310 323 341 350 369 408 415 424 442 510 530 559 562 619 626 628 650 657 661 669 707 714 747 760 805 818 820 831 840 858 909 916 925 949 951 206 253 360 425 509 564 458 503 541 971 702 725 775',
  'America/Denver': '303 719 720 970 983 385 435 801 505 575 406 307 208 986 915',
  'America/Phoenix': '480 520 602 623 928',
  'America/Chicago': '210 214 254 281 325 346 361 409 430 432 469 512 682 713 726 737 806 817 830 832 903 936 940 945 956 972 979 217 224 309 312 331 447 464 618 630 708 730 773 779 815 847 861 872 218 320 507 612 651 763 952 262 274 414 534 608 715 920 319 515 563 641 712 314 417 557 573 636 660 816 975 479 501 870 327 225 318 337 504 985 228 601 662 769 205 251 256 334 659 938 405 539 572 580 918 316 620 785 913 308 402 531 605 701 615 629 731 901 931 270 364 219',
  'America/Anchorage': '907',
  'Pacific/Honolulu': '808',
};

const BY_CODE = {};
for (const [tz, codes] of Object.entries(ZONES)) for (const c of codes.split(' ')) BY_CODE[c] = tz;

/** Time zone for a phone number ("+15125551234", "(512) ..."); Eastern when unknown. */
function tzForPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  const ten = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  return (ten.length === 10 && BY_CODE[ten.slice(0, 3)]) || 'America/New_York';
}

module.exports = { tzForPhone };
