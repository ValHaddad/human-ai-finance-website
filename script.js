// Mobile nav toggle
document.querySelector('.nav-toggle').addEventListener('click', function () {
    document.querySelector('.nav-links').classList.toggle('open');
});

// Close mobile nav when a link is clicked
document.querySelectorAll('.nav-links a').forEach(function (link) {
    link.addEventListener('click', function () {
        document.querySelector('.nav-links').classList.remove('open');
    });
});

// Highlight active nav link on scroll
var sections = document.querySelectorAll('section');
var navLinks = document.querySelectorAll('.nav-links a');

window.addEventListener('scroll', function () {
    var scrollPos = window.scrollY + 100;

    sections.forEach(function (section) {
        if (scrollPos >= section.offsetTop && scrollPos < section.offsetTop + section.offsetHeight) {
            var id = section.getAttribute('id');
            navLinks.forEach(function (link) {
                link.classList.remove('active');
                if (link.getAttribute('href') === '#' + id) {
                    link.classList.add('active');
                }
            });
        }
    });
});
