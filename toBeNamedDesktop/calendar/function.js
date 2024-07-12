const isLeapYear = (year) => {
    return (
      (year % 4 === 0 && year % 100 !== 0 && year % 400 !== 0) ||
      (year % 100 === 0 && year % 400 === 0)
    );
  };
  const getFebDays = (year) => {
    return isLeapYear(year) ? 29 : 28;
  };
  let calendar = document.querySelector('.calendar');
  let container = document.querySelector('.container');
  const month_names = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];
  let month_picker = document.querySelector('#month-picker');
  const timeFormate = document.querySelector('.time-formate');
  const dateFormate = document.querySelector('.date-formate');
  
  month_picker.onclick = () => {
    month_list_container.classList.remove('hideonce');
    month_list_container.classList.remove('hide');
    month_list_container.classList.add('show');
    timeFormate.classList.remove('showtime');
    timeFormate.classList.add('hideTime');
    dateFormate.classList.remove('showtime');
    dateFormate.classList.add('hideTime');
  };
  
  const generateCalendar = (month, year) => {
    let calendar_days = document.querySelector('.calendar-days');
    calendar_days.innerHTML = '';
    let calendar_header_year = document.querySelector('#year');
    let days_of_month = [
      31,
      getFebDays(year),
      31,
      30,
      31,
      30,
      31,
      31,
      30,
      31,
      30,
      31,
    ];
    let currentDate = new Date();
    month_picker.innerHTML = month_names[month];
    calendar_header_year.innerHTML = year;
    let first_day = new Date(year, month);
for (let i = 0; i <= days_of_month[month] + first_day.getDay() - 1; i++) {
      let day = document.createElement('div');
      if (i >= first_day.getDay()) {
        day.innerHTML = i - first_day.getDay() + 1;
        if (i - first_day.getDay() + 1 === currentDate.getDate() &&
          year === currentDate.getFullYear() &&
          month === currentDate.getMonth()
        ) {
          day.classList.add('current-date');
        }
      }
      calendar_days.appendChild(day);
    }
  };
  //Month list creation
  let month_list = container.querySelector('.month-list');
  let month_list_container = container.querySelector('.month-list-container');
  month_names.forEach((e, index) => {
    let month = document.createElement('div');
    month.innerHTML = `<div>${e}</div>`;
    month_list.append(month);
    month.onclick = () => {
      currentMonth = index;
      generateCalendar(currentMonth, currentYear);
      month_list_container.classList.replace('show', 'hide');
      timeFormate.classList.remove('hideTime');
      timeFormate.classList.add('showtime');
      dateFormate.classList.remove('hideTime');
      dateFormate.classList.add('showtime');
    };
  });
  //Month list creation END

  //Hide month list
  (function () {month_list_container.classList.add('hideonce');})();
  //Hide month list END

  //Go through years
  document.querySelector('#pre-year').onclick = () => {
    currentYear--;
    generateCalendar(currentMonth, currentYear);
  };
  document.querySelector('#next-year').onclick = () => {
    currentYear++;
    generateCalendar(currentMonth, currentYear);
  };
  //Go through years END
  //Go through months
  document.querySelector('#pre-month').onclick = () => {
    console.log("prev month");
    if(currentMonth==0){currentMonth=12;currentYear--;}
    currentMonth--;
    
    generateCalendar(currentMonth, currentYear);
  };
  document.querySelector('#next-month').onclick = () => {
    console.log("next month");
    if(currentMonth==11){currentMonth=-1;currentYear++;}
    currentMonth++;
    generateCalendar(currentMonth, currentYear);
  };
  //Go through months END

  let currentDate = new Date();
  let currentMonth = currentDate.getMonth();
  let currentYear = currentDate.getFullYear();
  generateCalendar(currentMonth, currentYear);

  const todayShowTime = document.querySelector('.time-formate');
  const todayShowDate = document.querySelector('.date-formate');
  
  const currshowDate = new Date();
  const showCurrentDateOption = {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  };
  const currentDateFormate = new Intl.DateTimeFormat(
    'en-US',
    showCurrentDateOption
  ).format(currshowDate);
  todayShowDate.textContent = currentDateFormate;
  setInterval(() => {
    const timer = new Date();
    const option = {
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    };
    const formateTimer = new Intl.DateTimeFormat('en-us', option).format(timer);
    let time = `${`${timer.getHours()}`.padStart(
      2,
      '0'
    )}:${`${timer.getMinutes()}`.padStart(
      2,
      '0'
    )}: ${`${timer.getSeconds()}`.padStart(2, '0')}`;
    todayShowTime.textContent = formateTimer;
  }, 1000);
  