document.addEventListener("DOMContentLoaded", function () {
    var editButton = document.getElementById("editButton");
    var cancelButton = document.getElementById("cancelButton");
    if (editButton) {
      editButton.addEventListener("click", function () {
        window.location.href = "/account?edit=true";
      });
    }
  });